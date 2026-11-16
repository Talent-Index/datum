import { createHash, createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";

import { accountByEmail } from "./accounts";
import { db, schema } from "./db";
import { normaliseEmail } from "./email";
import { linkGoogleIdentity } from "./identity";

/**
 * Google sign-in as an authorization-code flow with PKCE.
 *
 * The browser is sent to Google and comes back to /api/auth/google/callback.
 * A verified email becomes the same Datum session an emailed code would
 * issue, so the M-Pesa number and the platform fee still happen afterwards.
 * Nothing here runs unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
 */

const STATE_COOKIE = "datum_google_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_STATE_COOKIE = STATE_COOKIE;

export class GoogleAuthError extends Error {
  constructor(readonly reason: "unverified" | "exchange" | "id_token" | "userinfo" | "state") {
    super(reason);
    this.name = "GoogleAuthError";
  }
}

export interface GoogleProfile {
  email: string;
  sub: string;
  name: string | null;
}

export interface GoogleUserRecord {
  id: number;
  email: string;
  emailVerified: boolean;
}

export interface GoogleUsers {
  findByEmail(email: string): Promise<GoogleUserRecord | null>;
  markVerified(id: number): Promise<void>;
  remember(input: { email: string; googleSub: string; name: string | null; accountId: number | null }): Promise<"created" | "found">;
}

interface PendingOauth {
  state: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

interface JsonWebKey {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function sessionSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new GoogleAuthError("state");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function googleSignInEnabled(): boolean {
  return envValue("GOOGLE_CLIENT_ID") !== null && envValue("GOOGLE_CLIENT_SECRET") !== null;
}

/** Public site origin. APP_URL wins, then NEXT_PUBLIC_APP_URL, then this request. */
export function appBaseUrl(request: Request): string {
  const configured = envValue("APP_URL") ?? envValue("NEXT_PUBLIC_APP_URL");
  if (configured) return configured.replace(/\/$/, "");
  return new URL(request.url).origin;
}

export function googleCallbackUrl(request: Request): string {
  return `${appBaseUrl(request)}/api/auth/google/callback`;
}

/** Only same-site paths. Anything else returns the account page. */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return "/account";
  try {
    const url = new URL(raw, "https://datum.local");
    if (url.origin !== "https://datum.local") return "/account";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/account";
  }
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function googleAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export function sealGoogleState(pending: PendingOauth): string {
  const payload = Buffer.from(JSON.stringify(pending)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function openGoogleState(token: string | undefined, now = Date.now()): PendingOauth | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  let raw: Partial<PendingOauth>;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<PendingOauth>;
  } catch {
    return null;
  }
  if (typeof raw.state !== "string" || typeof raw.verifier !== "string" || typeof raw.returnTo !== "string" || typeof raw.exp !== "number") return null;
  if (raw.exp < now) return null;
  return { state: raw.state, verifier: raw.verifier, returnTo: safeReturnPath(raw.returnTo), exp: raw.exp };
}

export function googleStateCookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: string; maxAge: number } {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/google",
    maxAge: STATE_TTL_MS / 1000,
  };
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function beginGoogleSignIn(request: Request, now = Date.now()): { location: string; cookie: string | null } {
  const base = appBaseUrl(request);
  if (!googleSignInEnabled()) return { location: `${base}/account?google=unavailable`, cookie: null };
  const clientId = envValue("GOOGLE_CLIENT_ID");
  if (!clientId) return { location: `${base}/account?google=unavailable`, cookie: null };
  const next = safeReturnPath(new URL(request.url).searchParams.get("next"));
  const { verifier, challenge } = createPkce();
  const state = randomBytes(32).toString("base64url");
  const cookie = sealGoogleState({ state, verifier, returnTo: next, exp: now + STATE_TTL_MS });
  const location = googleAuthorizeUrl({
    clientId,
    redirectUri: googleCallbackUrl(request),
    state,
    challenge,
  });
  return { location, cookie };
}

function verifiedFlag(value: unknown): boolean {
  return value === true || value === "true";
}

export function verifyGoogleIdToken(idToken: string, jwks: { keys?: JsonWebKey[] }, clientId: string, now = Date.now()): GoogleProfile {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleAuthError("id_token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new GoogleAuthError("id_token");
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString()) as { alg?: string; kid?: string };
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString()) as Record<string, unknown>;
  } catch {
    throw new GoogleAuthError("id_token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new GoogleAuthError("id_token");
  const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.kty === "RSA" && key.n && key.e);
  if (!jwk?.n || !jwk.e) throw new GoogleAuthError("id_token");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" } as unknown as Parameters<typeof createPublicKey>[0]);
  const valid = verifier.verify(publicKey, Buffer.from(encodedSignature, "base64url"));
  if (!valid) throw new GoogleAuthError("id_token");
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new GoogleAuthError("id_token");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw new GoogleAuthError("id_token");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new GoogleAuthError("id_token");
  if (typeof claims.email !== "string" || !claims.email.includes("@")) throw new GoogleAuthError("id_token");
  if (!verifiedFlag(claims.email_verified)) throw new GoogleAuthError("unverified");
  if (typeof claims.sub !== "string" || !claims.sub) throw new GoogleAuthError("id_token");
  return { email: claims.email, sub: claims.sub, name: typeof claims.name === "string" ? claims.name : null };
}

export function userinfoAgrees(profile: GoogleProfile, userinfo: { email?: unknown; email_verified?: unknown; sub?: unknown }): boolean {
  if (typeof userinfo.email !== "string" || !verifiedFlag(userinfo.email_verified)) return false;
  if (normaliseEmail(userinfo.email) !== normaliseEmail(profile.email)) return false;
  return typeof userinfo.sub !== "string" || userinfo.sub === profile.sub;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export async function exchangeGoogleCode(input: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl: typeof fetch;
}): Promise<{ idToken: string; accessToken: string }> {
  const response = await input.fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.verifier,
    }),
  });
  if (!response.ok) throw new GoogleAuthError("exchange");
  const json = (await readJson(response)) as { id_token?: unknown; access_token?: unknown };
  if (typeof json.id_token !== "string" || typeof json.access_token !== "string") throw new GoogleAuthError("exchange");
  return { idToken: json.id_token, accessToken: json.access_token };
}

/**
 * An existing account for this email is reused. A first visit only records
 * the verified email; the account form still collects the role and M-Pesa number.
 */
export async function findOrCreateGoogleUser(users: GoogleUsers, profile: GoogleProfile): Promise<{ email: string; created: boolean; accountId: number | null }> {
  const email = normaliseEmail(profile.email);
  const existing = await users.findByEmail(email);
  if (existing && !existing.emailVerified) await users.markVerified(existing.id);
  const remembered = await users.remember({ email, googleSub: profile.sub, name: profile.name, accountId: existing?.id ?? null });
  return { email, created: !existing && remembered === "created", accountId: existing?.id ?? null };
}

export function dbGoogleUsers(): GoogleUsers {
  return {
    async findByEmail(email) {
      const account = await accountByEmail(email);
      if (!account) return null;
      return { id: account.id, email: account.email ?? normaliseEmail(email), emailVerified: account.emailVerified };
    },
    async markVerified(id) {
      await db().update(schema.accounts).set({ emailVerified: true }).where(eq(schema.accounts.id, id));
    },
    async remember(input) {
      await linkGoogleIdentity({ email: input.email, googleSub: input.googleSub, name: input.name });
      return input.accountId === null ? "created" : "found";
    },
  };
}

export async function finishGoogleSignIn(
  request: Request,
  options: { fetchImpl?: typeof fetch; users?: GoogleUsers; now?: number } = {},
): Promise<{ location: string; email: string | null }> {
  const base = appBaseUrl(request);
  const failed = (reason: string) => ({ location: `${base}/account?google=${reason}`, email: null as string | null });
  if (!googleSignInEnabled()) return failed("unavailable");
  const url = new URL(request.url);
  const googleError = url.searchParams.get("error");
  if (googleError === "access_denied") return failed("cancelled");
  if (googleError) return failed("failed");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const pending = openGoogleState(cookieValue(request, STATE_COOKIE), options.now);
  if (!code || !state || !pending || !safeEqual(pending.state, state)) return failed("state");
  const clientId = envValue("GOOGLE_CLIENT_ID");
  const clientSecret = envValue("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return failed("unavailable");
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const tokens = await exchangeGoogleCode({
      code,
      verifier: pending.verifier,
      clientId,
      clientSecret,
      redirectUri: googleCallbackUrl(request),
      fetchImpl,
    });
    const certsResponse = await fetchImpl(CERTS_URL);
    if (!certsResponse.ok) throw new GoogleAuthError("id_token");
    const certs = (await readJson(certsResponse)) as { keys?: JsonWebKey[] };
    const profile = verifyGoogleIdToken(tokens.idToken, certs, clientId, options.now);
    const infoResponse = await fetchImpl(USERINFO_URL, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
    if (!infoResponse.ok) throw new GoogleAuthError("userinfo");
    const userinfo = (await readJson(infoResponse)) as { email?: unknown; email_verified?: unknown; sub?: unknown };
    if (!userinfoAgrees(profile, userinfo)) throw new GoogleAuthError("unverified");
    const linked = await findOrCreateGoogleUser(options.users ?? dbGoogleUsers(), profile);
    return { location: `${base}${pending.returnTo}`, email: linked.email };
  } catch (error) {
    if (error instanceof GoogleAuthError && error.reason === "unverified") return failed("unverified");
    console.error(`[google] sign-in failed: ${error instanceof GoogleAuthError ? error.reason : "failed"}`);
    return failed("failed");
  }
}
