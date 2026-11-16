import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/accounts", () => ({
  accountByEmail: vi.fn(async () => null),
}));

import { GET as googleCallback } from "@/app/api/auth/google/callback/route";
import { readSenderToken } from "@/lib/auth";
import {
  beginGoogleSignIn,
  findOrCreateGoogleUser,
  finishGoogleSignIn,
  googleStateCookieOptions,
  type GoogleProfile,
  type GoogleUsers,
} from "@/lib/google-auth";

const CLIENT = "client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "google-client-secret";
const { privateKey, jwk } = (() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = pair.publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
  return { privateKey: pair.privateKey, jwk: { ...exported, kid: "test-key", alg: "RS256", use: "sig" } };
})();

function idToken(key: KeyObject, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "Ada@gmail.com",
    email_verified: true,
    sub: "google-sub-1",
    name: "Ada Wanjiku",
    ...overrides,
  };
}

function memoryUsers(): { users: GoogleUsers; links: Array<{ email: string; googleSub: string }>; verified: number[]; seed: (email: string, emailVerified: boolean) => void } {
  const accounts = new Map<string, { id: number; emailVerified: boolean }>();
  const links: Array<{ email: string; googleSub: string }> = [];
  const verified: number[] = [];
  let next = 1;
  return {
    links,
    verified,
    users: {
      async findByEmail(email) {
        const row = accounts.get(email);
        return row ? { id: row.id, email, emailVerified: row.emailVerified } : null;
      },
      async markVerified(id) {
        verified.push(id);
        for (const [email, row] of accounts.entries()) if (row.id === id) accounts.set(email, { ...row, emailVerified: true });
      },
      async remember(input) {
        const existing = links.find((link) => link.email === input.email);
        if (existing) {
          existing.googleSub = input.googleSub;
          return "found";
        }
        links.push({ email: input.email, googleSub: input.googleSub });
        return "created";
      },
    },
    seed(email: string, emailVerified: boolean) {
      accounts.set(email, { id: next++, emailVerified });
    },
  };
}

function googleFetch(token: string, userinfo: Record<string, unknown>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ id_token: token, access_token: "access-token" }), { status: 200 });
    }
    if (target === "https://www.googleapis.com/oauth2/v3/certs") {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    if (target === "https://www.googleapis.com/oauth2/v3/userinfo") {
      const headers = new Headers(init?.headers);
      if (headers.get("authorization") !== "Bearer access-token") return new Response("no", { status: 401 });
      return new Response(JSON.stringify(userinfo), { status: 200 });
    }
    throw new Error(`unexpected ${target}`);
  });
}

describe("Google sign-in", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function enableGoogle(): void {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("SESSION_SECRET", "12345678901234567890123456789012");
    vi.stubEnv("APP_URL", "https://datum-roan.vercel.app");
  }

  it("hides the start when Google is not configured and keeps the state cookie short and httpOnly", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("SESSION_SECRET", "12345678901234567890123456789012");
    const begun = beginGoogleSignIn(new Request("https://datum-roan.vercel.app/api/auth/google"));
    expect(begun.cookie).toBeNull();
    expect(begun.location).toContain("/account?google=unavailable");
    expect(googleStateCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/auth/google", maxAge: 600, secure: false });
    vi.stubEnv("NODE_ENV", "production");
    expect(googleStateCookieOptions().secure).toBe(true);
  });

  it("sends PKCE and the production redirect URI, then rejects a mismatched state", async () => {
    enableGoogle();
    const begun = beginGoogleSignIn(new Request("https://datum-roan.vercel.app/api/auth/google?next=/buy"));
    const authorize = new URL(begun.location);
    expect(authorize.origin).toBe("https://accounts.google.com");
    expect(authorize.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorize.searchParams.get("scope")).toBe("openid email profile");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://datum-roan.vercel.app/api/auth/google/callback");
    expect(authorize.searchParams.get("state")).toBeTruthy();
    expect(begun.cookie).toBeTruthy();
    const fetchImpl = googleFetch(idToken(privateKey, claims()), { email: "ada@gmail.com", email_verified: true, sub: "google-sub-1" });
    const users = memoryUsers();
    const callback = new URL("https://datum-roan.vercel.app/api/auth/google/callback");
    callback.searchParams.set("code", "auth-code");
    callback.searchParams.set("state", "not-the-cookie-state");
    const result = await finishGoogleSignIn(new Request(callback, { headers: { cookie: `datum_google_oauth=${begun.cookie}` } }), { fetchImpl, users: users.users });
    expect(result.email).toBeNull();
    expect(result.location).toContain("/account?google=state");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(users.links).toEqual([]);
  });

  it("rejects an unverified Google email and does not start a session", async () => {
    enableGoogle();
    const begun = beginGoogleSignIn(new Request("https://datum-roan.vercel.app/api/auth/google"));
    const state = new URL(begun.location).searchParams.get("state");
    const fetchImpl = googleFetch(idToken(privateKey, claims({ email_verified: false })), { email: "ada@gmail.com", email_verified: false, sub: "google-sub-1" });
    const users = memoryUsers();
    const callback = new URL("https://datum-roan.vercel.app/api/auth/google/callback");
    callback.searchParams.set("code", "auth-code");
    callback.searchParams.set("state", state ?? "");
    const result = await finishGoogleSignIn(new Request(callback, { headers: { cookie: `datum_google_oauth=${begun.cookie}` } }), { fetchImpl, users: users.users });
    expect(result.email).toBeNull();
    expect(result.location).toContain("/account?google=unverified");
    expect(users.links).toEqual([]);
  });

  it("finds an existing email and creates one only the first time", async () => {
    const store = memoryUsers();
    const profile: GoogleProfile = { email: "Ada@gmail.com", sub: "google-sub-1", name: "Ada Wanjiku" };
    const created = await findOrCreateGoogleUser(store.users, profile);
    expect(created).toEqual({ email: "ada@gmail.com", created: true, accountId: null });
    const again = await findOrCreateGoogleUser(store.users, profile);
    expect(again).toEqual({ email: "ada@gmail.com", created: false, accountId: null });
    expect(store.links).toEqual([{ email: "ada@gmail.com", googleSub: "google-sub-1" }]);

    store.seed("ada@gmail.com", false);
    const found = await findOrCreateGoogleUser(store.users, profile);
    expect(found.created).toBe(false);
    expect(found.accountId).toBe(1);
    expect(store.verified).toEqual([1]);
  });

  it("sets the email session after Google verifies the address", async () => {
    enableGoogle();
    const begun = beginGoogleSignIn(new Request("https://datum-roan.vercel.app/api/auth/google?next=/buy"));
    const state = new URL(begun.location).searchParams.get("state") ?? "";
    const token = idToken(privateKey, claims());
    const fetchImpl = googleFetch(token, { email: "ada@gmail.com", email_verified: true, sub: "google-sub-1" });
    const users = memoryUsers();
    const callback = new URL("https://datum-roan.vercel.app/api/auth/google/callback");
    callback.searchParams.set("code", "auth-code");
    callback.searchParams.set("state", state);
    const request = new Request(callback, { headers: { cookie: `datum_google_oauth=${begun.cookie}` } });
    const result = await finishGoogleSignIn(request, { fetchImpl, users: users.users });
    expect(result.email).toBe("ada@gmail.com");
    expect(result.location).toBe("https://datum-roan.vercel.app/buy");
    const tokenCall = fetchImpl.mock.calls.find((call) => String(call[0]) === "https://oauth2.googleapis.com/token");
    expect(String(tokenCall?.[1]?.body)).toContain("code_verifier=");
    expect(String(tokenCall?.[1]?.body)).toContain("redirect_uri=https%3A%2F%2Fdatum-roan.vercel.app%2Fapi%2Fauth%2Fgoogle%2Fcallback");
    vi.stubGlobal("fetch", fetchImpl);
    const response = await googleCallback(request);
    const session = readSenderToken(response.cookies.get("datum_sender")?.value);
    expect(session?.email).toBe("ada@gmail.com");
    expect(session?.phone).toBeNull();
    expect(response.headers.get("location")).toBe("https://datum-roan.vercel.app/buy");
    const stateCookie = response.cookies.get("datum_google_oauth");
    expect(stateCookie?.value).toBe("");
  });
});
