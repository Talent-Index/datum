import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";

/**
 * Who is allowed to do what.
 *
 * Two kinds of caller. A sender proves they hold a phone number with a
 * one-time code and gets a signed cookie bound to that number; every action
 * that spends or approves in their name reads the number from the cookie,
 * never from the request body. An operator — the platform's own staff —
 * presents a shared secret, as a bearer token from scripts or a cookie from
 * the register page.
 *
 * Sessions are HMAC-signed, not stored: the secret is the only state, so a
 * serverless instance that has never seen a session can still verify it.
 */

const SENDER_COOKIE = "datum_sender";
const OPERATOR_COOKIE = "datum_operator";
const SESSION_DAYS = 7;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET is not set or is shorter than 32 characters");
  }
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SenderSession {
  phone: string;
  issuedAt: number;
  expiresAt: number;
}

export function issueSenderToken(phone: string): string {
  const now = Date.now();
  const session: SenderSession = {
    phone,
    issuedAt: now,
    expiresAt: now + SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSenderToken(token: string | undefined): SenderSession | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!safeEqual(sign(payload), signature)) return null;
  let session: SenderSession;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString()) as SenderSession;
  } catch {
    return null;
  }
  if (typeof session.phone !== "string" || session.expiresAt < Date.now()) return null;
  return session;
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** The verified sender on this request, or null. */
export function currentSender(request: Request): SenderSession | null {
  return readSenderToken(cookieValue(request, SENDER_COOKIE));
}

export function setSenderCookie(response: NextResponse, token: string): void {
  response.cookies.set(SENDER_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearSenderCookie(response: NextResponse): void {
  response.cookies.set(SENDER_COOKIE, "", { path: "/", maxAge: 0 });
}

/**
 * Operator access: the platform's own staff. A bearer token for scripts and
 * a cookie for the register page, both carrying the same secret.
 */
export function isOperator(request: Request): boolean {
  const expected = process.env.OPERATOR_SECRET;
  if (!expected || expected.length < 16) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && safeEqual(bearer, expected)) return true;
  const cookie = cookieValue(request, OPERATOR_COOKIE);
  return cookie !== undefined && safeEqual(cookie, sign("operator"));
}

export function setOperatorCookie(response: NextResponse): void {
  response.cookies.set(OPERATOR_COOKIE, sign("operator"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearOperatorCookie(response: NextResponse): void {
  response.cookies.set(OPERATOR_COOKIE, "", { path: "/", maxAge: 0 });
}

export function checkOperatorSecret(candidate: string): boolean {
  const expected = process.env.OPERATOR_SECRET;
  return !!expected && expected.length >= 16 && safeEqual(candidate, expected);
}

/** Six digits, from a CSPRNG. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Codes are stored hashed; a leaked table does not leak live codes. */
export function hashOtp(phone: string, code: string): string {
  return createHmac("sha256", secret()).update(`${phone}:${code}`).digest("hex");
}
