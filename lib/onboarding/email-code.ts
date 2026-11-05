import { timingSafeEqual } from "node:crypto";

import { OTP_INVALID, OTP_LIMIT, OTP_SENT, OTP_WAIT } from "@/lib/otp-message";

/**
 * Email one-time codes. The code is returned only to the caller that sends
 * the mail. HTTP responses use publicOtpResponse and never include it.
 */

export const CODE_TTL_MS = 5 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const MAX_REQUESTS_PER_HOUR = 5;
export const MAX_VERIFY_ATTEMPTS = 5;
export const MAX_VERIFIES_PER_HOUR = 10;

export interface OtpRecord {
  subject: string;
  codeHash: string;
  attempts: number;
  expiresAt: number;
  createdAt: number;
}

export interface OtpDirectory {
  live(subject: string): Promise<OtpRecord | null>;
  replace(record: OtpRecord): Promise<void>;
  setAttempts(subject: string, attempts: number): Promise<void>;
  remove(subject: string): Promise<void>;
  countEvents(subject: string, kind: "request" | "verify", since: number): Promise<number>;
  addEvent(subject: string, kind: "request" | "verify", at: number): Promise<void>;
}

export type IssueResult =
  | { ok: true; email: string; code: string }
  | { ok: false; status: 429; error: string };

export type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; status: 400 | 429; error: string };

export function publicOtpResponse(): { ok: true; message: string } {
  return { ok: true, message: OTP_SENT };
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function issueEmailCode(
  directory: OtpDirectory,
  email: string,
  now: number,
  nextCode: () => string,
  hash: (subject: string, code: string) => string,
): Promise<IssueResult> {
  const requests = await directory.countEvents(email, "request", now - HOUR_MS);
  if (requests >= MAX_REQUESTS_PER_HOUR) return { ok: false, status: 429, error: OTP_LIMIT };
  const live = await directory.live(email);
  if (live && now - live.createdAt < RESEND_COOLDOWN_MS) return { ok: false, status: 429, error: OTP_WAIT };
  const code = nextCode();
  await directory.replace({
    subject: email,
    codeHash: hash(email, code),
    attempts: 0,
    expiresAt: now + CODE_TTL_MS,
    createdAt: now,
  });
  await directory.addEvent(email, "request", now);
  return { ok: true, email, code };
}

export async function verifyEmailCode(
  directory: OtpDirectory,
  email: string,
  code: string,
  now: number,
  hash: (subject: string, code: string) => string,
): Promise<VerifyResult> {
  const verifies = await directory.countEvents(email, "verify", now - HOUR_MS);
  if (verifies >= MAX_VERIFIES_PER_HOUR) return { ok: false, status: 429, error: OTP_LIMIT };
  await directory.addEvent(email, "verify", now);
  const live = await directory.live(email);
  if (!live || live.expiresAt <= now) {
    if (live) await directory.remove(email);
    return { ok: false, status: 400, error: OTP_INVALID };
  }
  if (live.attempts >= MAX_VERIFY_ATTEMPTS) {
    await directory.remove(email);
    return { ok: false, status: 429, error: OTP_LIMIT };
  }
  if (!hashesMatch(live.codeHash, hash(email, code))) {
    const attempts = live.attempts + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await directory.remove(email);
      return { ok: false, status: 429, error: OTP_LIMIT };
    }
    await directory.setAttempts(email, attempts);
    return { ok: false, status: 400, error: OTP_INVALID };
  }
  await directory.remove(email);
  return { ok: true, email };
}

/** In-memory directory for tests. One live code per address. */
export function memoryOtpDirectory(): OtpDirectory {
  let live: OtpRecord | null = null;
  const events: Array<{ subject: string; kind: "request" | "verify"; at: number }> = [];
  return {
    async live(subject) {
      return live?.subject === subject ? live : null;
    },
    async replace(record) {
      live = record;
    },
    async setAttempts(subject, attempts) {
      if (live?.subject === subject) live = { ...live, attempts };
    },
    async remove(subject) {
      if (live?.subject === subject) live = null;
    },
    async countEvents(subject, kind, since) {
      return events.filter((event) => event.subject === subject && event.kind === kind && event.at >= since).length;
    },
    async addEvent(subject, kind, at) {
      events.push({ subject, kind, at });
    },
  };
}
