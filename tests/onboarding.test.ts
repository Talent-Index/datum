import { afterEach, describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/accounts";
import { paymentDestination, sessionOwnsAccount } from "@/lib/accounts";
import type { SenderSession } from "@/lib/auth";
import { emailTransport, sendEmail } from "@/lib/email";
import { normalizePhone } from "@/lib/daraja";
import {
  CODE_TTL_MS,
  issueEmailCode,
  memoryOtpDirectory,
  publicOtpResponse,
  RESEND_COOLDOWN_MS,
  verifyEmailCode,
} from "@/lib/onboarding/email-code";
import {
  applyFeeCallback,
  FEE_PROMPT_TIMEOUT_MS,
  FEE_PUSH_COOLDOWN_MS,
  memoryFeeDirectory,
  reconcileFeeRow,
  requestPlatformFee,
  type FeeAccount,
} from "@/lib/onboarding/fee";
import { OTP_INVALID, OTP_LIMIT } from "@/lib/otp-message";

const hash = (subject: string, code: string) => `${subject}:${code}`;
const email = "ada@example.com";

function session(partial: Partial<SenderSession>): SenderSession {
  return { subject: email, phone: null, email, issuedAt: 0, expiresAt: 1, ...partial };
}

function fakeAccount(partial: Partial<Account>): Account {
  return {
    id: 1,
    subject: email,
    email,
    emailVerified: true,
    phone: null,
    phoneVerified: false,
    role: "sender",
    displayName: "Ada",
    companyName: null,
    registrationNumber: null,
    address: "0xabc",
    kycStatus: "none",
    feeStatus: "none",
    feePaidAt: null,
    registryTxHash: null,
    createdAt: new Date(0),
    ...partial,
  };
}

const sender: FeeAccount = { id: 7, role: "sender", feeStatus: "none", phone: "0712 345 678" };
const buyer: FeeAccount = { id: 8, role: "buyer", feeStatus: "none", phone: "0712345678" };

describe("email codes", () => {
  it("issues one code, verifies it once, and rejects a reuse", async () => {
    const directory = memoryOtpDirectory();
    const issued = await issueEmailCode(directory, email, 1_000, () => "042013", hash);
    expect(issued.ok).toBe(true);
    expect(publicOtpResponse().message).not.toMatch(/\d{6}/);
    expect(JSON.stringify(publicOtpResponse())).not.toContain("042013");
    const good = await verifyEmailCode(directory, email, "042013", 1_000 + 1_000, hash);
    expect(good).toEqual({ ok: true, email });
    const again = await verifyEmailCode(directory, email, "042013", 1_000 + 2_000, hash);
    expect(again).toMatchObject({ ok: false, status: 400, error: OTP_INVALID });
  });

  it("rejects a wrong code without saying how it was wrong, then locks the code", async () => {
    const directory = memoryOtpDirectory();
    await issueEmailCode(directory, email, 1_000, () => "111111", hash);
    for (let i = 0; i < 4; i += 1) {
      const wrong = await verifyEmailCode(directory, email, "000000", 2_000 + i, hash);
      expect(wrong).toMatchObject({ ok: false, status: 400, error: OTP_INVALID });
      expect(wrong.ok === false && wrong.error).not.toMatch(/attempt/);
    }
    const locked = await verifyEmailCode(directory, email, "000000", 3_000, hash);
    expect(locked).toMatchObject({ ok: false, status: 429, error: OTP_LIMIT });
    const after = await verifyEmailCode(directory, email, "111111", 4_000, hash);
    expect(after).toMatchObject({ ok: false, status: 400, error: OTP_INVALID });
  });

  it("rejects an expired code and a resend inside the cooldown", async () => {
    const directory = memoryOtpDirectory();
    await issueEmailCode(directory, email, 1_000, () => "222222", hash);
    const expired = await verifyEmailCode(directory, email, "222222", 1_000 + CODE_TTL_MS + 1, hash);
    expect(expired).toMatchObject({ ok: false, status: 400, error: OTP_INVALID });
    const first = await issueEmailCode(directory, email, 10_000, () => "333333", hash);
    expect(first.ok).toBe(true);
    const soon = await issueEmailCode(directory, email, 10_000 + RESEND_COOLDOWN_MS - 1, () => "444444", hash);
    expect(soon).toMatchObject({ ok: false, status: 429 });
  });

  it("stops requesting after five codes in an hour", async () => {
    const directory = memoryOtpDirectory();
    for (let i = 0; i < 5; i += 1) {
      const issued = await issueEmailCode(directory, email, i * RESEND_COOLDOWN_MS, () => "555555", hash);
      expect(issued.ok).toBe(true);
    }
    const blocked = await issueEmailCode(directory, email, 5 * RESEND_COOLDOWN_MS, () => "666666", hash);
    expect(blocked).toMatchObject({ ok: false, status: 429, error: OTP_LIMIT });
  });
});

describe("returning accounts stay separate", () => {
  it("returns the same email account and ignores a typed phone and an unverified email", () => {
    const ada = fakeAccount({ id: 1, subject: "ada@example.com", email: "ada@example.com", emailVerified: true, phone: "254711111111", feeStatus: "paid" });
    const bo = fakeAccount({ id: 2, subject: "bo@example.com", email: "bo@example.com", emailVerified: true, phone: "254722222222" });
    const contact = fakeAccount({ id: 3, subject: "254733333333", email: "ada@example.com", emailVerified: false, phone: "254733333333" });
    const adaSession = session({ subject: "ada@example.com", email: "ada@example.com", phone: "254722222222" });
    expect(sessionOwnsAccount(adaSession, ada)).toBe(true);
    expect(sessionOwnsAccount(adaSession, bo)).toBe(false);
    expect(sessionOwnsAccount(adaSession, contact)).toBe(false);
    expect(paymentDestination(adaSession, ada)).toBe("254711111111");
    expect(paymentDestination(adaSession, null)).toBeNull();
    const legacy = session({ subject: "254733333333", email: null, phone: "254733333333" });
    expect(sessionOwnsAccount(legacy, contact)).toBe(true);
    expect(paymentDestination(legacy, null)).toBe("254733333333");
  });
});

describe("platform fee prompt", () => {
  const amount = 200;

  it("sends KES 200 to the normalised number and does not mint an escrow claim", async () => {
    const directory = memoryFeeDirectory();
    const pushes: Array<{ phone: string; amount: number }> = [];
    const result = await requestPlatformFee(directory, sender, 1_000, amount, async () => ({ state: "processing" }), async (phone, kes) => {
      pushes.push({ phone, amount: kes });
      return { CheckoutRequestID: "ws_CO_1", MerchantRequestID: "m-1" };
    });
    expect(result).toMatchObject({ ok: true, reused: false, phone: "254712345678", amountKes: 200, escrowClaim: false });
    expect(pushes).toEqual([{ phone: "254712345678", amount: 200 }]);
    expect(normalizePhone("0712 345 678")).toBe("254712345678");
    expect(directory.paid).toEqual([]);
  });

  it("does not charge a buyer or a sender who already paid", async () => {
    const directory = memoryFeeDirectory();
    const push = vi.fn();
    const noBuyer = await requestPlatformFee(directory, buyer, 1_000, amount, async () => ({ state: "processing" }), push);
    expect(noBuyer).toMatchObject({ ok: false, status: 409 });
    const paid = await requestPlatformFee(directory, { ...sender, feeStatus: "paid" }, 1_000, amount, async () => ({ state: "processing" }), push);
    expect(paid).toMatchObject({ ok: false, status: 409 });
    expect(push).not.toHaveBeenCalled();
  });

  it("reuses an open prompt instead of sending a second one", async () => {
    const directory = memoryFeeDirectory();
    let n = 0;
    const push = async () => ({ CheckoutRequestID: `ws_CO_${++n}`, MerchantRequestID: `m-${n}` });
    await requestPlatformFee(directory, sender, 5_000, amount, async () => ({ state: "processing" }), push);
    const second = await requestPlatformFee(directory, sender, 5_000 + FEE_PUSH_COOLDOWN_MS - 1, amount, async () => ({ state: "processing" }), push);
    expect(second).toMatchObject({ ok: true, reused: true, checkoutRequestId: "ws_CO_1", amountKes: 200 });
    expect(n).toBe(1);
  });

  it("records a cancel, a timeout, and a retry, and ignores a duplicate callback", async () => {
    const directory = memoryFeeDirectory();
    let n = 0;
    const push = async (phone: string, kes: number) => {
      expect(phone).toBe("254712345678");
      expect(kes).toBe(200);
      n += 1;
      return { CheckoutRequestID: `ws_CO_${n}`, MerchantRequestID: `m-${n}` };
    };
    await requestPlatformFee(directory, sender, 10_000, amount, async () => ({ state: "processing" }), push);
    const cancelled = await applyFeeCallback(
      directory,
      { checkoutRequestId: "ws_CO_1", resultCode: 1032, resultDesc: "Request cancelled by user", receipt: null },
      11_000,
      async () => ({ state: "failed", reason: "Request cancelled by user" }),
    );
    expect(cancelled).toMatchObject({ status: "cancelled", escrowClaim: false });
    expect(directory.paid).toEqual([]);
    const again = await applyFeeCallback(
      directory,
      { checkoutRequestId: "ws_CO_1", resultCode: 1032, resultDesc: "Request cancelled by user", receipt: null },
      12_000,
      async () => ({ state: "failed", reason: "Request cancelled by user" }),
    );
    expect(again.status).toBe("cancelled");
    expect(directory.rows.filter((row) => row.status === "confirmed")).toHaveLength(0);

    await requestPlatformFee(directory, sender, 20_000, amount, async () => ({ state: "processing" }), push);
    const open = directory.rows.find((row) => row.checkoutRequestId === "ws_CO_2");
    const timedOut = await reconcileFeeRow(directory, open!, 20_000 + FEE_PROMPT_TIMEOUT_MS, async () => ({ state: "processing" }));
    expect(timedOut).toMatchObject({ status: "timeout" });

    await requestPlatformFee(directory, sender, 40_000, amount, async () => ({ state: "processing" }), push);
    const forged = await applyFeeCallback(
      directory,
      { checkoutRequestId: "ws_CO_3", resultCode: 0, resultDesc: "Success", receipt: "RCPT1" },
      41_000,
      async () => ({ state: "failed", reason: "cancelled" }),
    );
    expect(forged.status).not.toBe("confirmed");
    expect(directory.paid).toEqual([]);

    const paid = await applyFeeCallback(
      directory,
      { checkoutRequestId: "ws_CO_3", resultCode: 0, resultDesc: "Success", receipt: "RCPT1" },
      42_000,
      async () => ({ state: "paid" }),
    );
    expect(paid).toMatchObject({ status: "confirmed", escrowClaim: false });
    const duplicate = await applyFeeCallback(
      directory,
      { checkoutRequestId: "ws_CO_3", resultCode: 0, resultDesc: "Success", receipt: "RCPT1" },
      43_000,
      async () => ({ state: "paid" }),
    );
    expect(duplicate).toMatchObject({ ignored: true, status: "confirmed" });
    expect(directory.paid).toEqual([7]);
    expect(n).toBe(3);
  });

  it("does not apply one receipt to a second fee", async () => {
    const directory = memoryFeeDirectory();
    await directory.insert({
      accountId: 7,
      phone: "254712345678",
      amountKes: 200,
      checkoutRequestId: "ws_CO_a",
      merchantRequestId: null,
      status: "pending",
      mpesaReceipt: null,
      resultDescription: null,
      createdAt: 1,
      completedAt: null,
    });
    await directory.insert({
      accountId: 9,
      phone: "254700000009",
      amountKes: 200,
      checkoutRequestId: "ws_CO_b",
      merchantRequestId: null,
      status: "confirmed",
      mpesaReceipt: "SAME",
      resultDescription: null,
      createdAt: 1,
      completedAt: 2,
    });
    const result = await applyFeeCallback(directory, { checkoutRequestId: "ws_CO_a", resultCode: 0, resultDesc: "Success", receipt: "SAME" }, 3, async () => ({ state: "paid" }));
    expect(result.status).toBe("failed");
    expect(directory.paid).toEqual([]);
  });
});

describe("email delivery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed in production and does not log the code", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("EMAIL_OTP_DEV_LOG", "1");
    expect(emailTransport()).toBe("closed");
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await sendEmail("ada@example.com", "Your Datum sign-in code", "042013 is your Datum code.");
    expect(result).toEqual({ delivered: false, via: "closed" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logs the code only when development delivery is explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("EMAIL_OTP_DEV_LOG", "");
    expect(emailTransport()).toBe("closed");
    vi.stubEnv("EMAIL_OTP_DEV_LOG", "1");
    expect(emailTransport()).toBe("dev-log");
  });
});
