import { FEE_ROLES } from "@/lib/accounts";
import { normaliseMsisdn } from "@/lib/chain";
import type { StkQueryResult } from "@/lib/daraja";

/**
 * The one-off platform fee (LISTING_FEE_KES, KES 200 by default).
 *
 * It is charged to sellers, developers, companies and senders before they
 * post or commit. It is not a signup fee and it does not mint an escrow
 * claim. The M-Pesa number is the prompt destination. A paid fee does not
 * mark that number as proof of identity.
 */

export const FEE_PUSH_COOLDOWN_MS = 90 * 1000;
export const FEE_PROMPT_TIMEOUT_MS = 120 * 1000;

export interface FeeAccount {
  id: number;
  role: string;
  feeStatus: string;
  phone: string | null;
}

export interface FeeRow {
  id: number;
  accountId: number;
  phone: string;
  amountKes: number;
  checkoutRequestId: string;
  merchantRequestId: string | null;
  status: string;
  mpesaReceipt: string | null;
  resultDescription: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface FeeDirectory {
  listFees(accountId: number): Promise<FeeRow[]>;
  findByCheckout(checkoutRequestId: string): Promise<FeeRow | null>;
  findByReceipt(receipt: string): Promise<FeeRow | null>;
  insert(row: Omit<FeeRow, "id">): Promise<FeeRow>;
  update(id: number, patch: Partial<Omit<FeeRow, "id" | "accountId">>): Promise<FeeRow>;
  markFeePaid(accountId: number, at: number): Promise<void>;
  /** A failed, cancelled or timed-out prompt is no longer in flight. */
  noteFeeClosed(accountId: number): Promise<void>;
}

export interface FeePush {
  CheckoutRequestID: string;
  MerchantRequestID: string;
}

export type FeeQuery = (checkoutRequestId: string) => Promise<StkQueryResult>;

type FeeFailure = { ok: false; status: number; error: string };
type FeeRequestOk = { ok: true; reused: boolean; checkoutRequestId: string; phone: string; amountKes: number; escrowClaim: false };

function feeIsDue(account: FeeAccount): boolean {
  return (FEE_ROLES as readonly string[]).includes(account.role) && account.feeStatus !== "paid";
}

function failureKind(code: number, desc: string): "cancelled" | "timeout" | "failed" {
  if (code === 1032 || /cancel/i.test(desc)) return "cancelled";
  if (code === 1037 || /timeout/i.test(desc)) return "timeout";
  return "failed";
}

function kindFromReason(reason: string): "cancelled" | "timeout" | "failed" {
  if (/cancel/i.test(reason)) return "cancelled";
  if (/timeout/i.test(reason)) return "timeout";
  return "failed";
}

async function alreadyPaid(directory: FeeDirectory, account: FeeAccount): Promise<boolean> {
  if (account.feeStatus === "paid") return true;
  const rows = await directory.listFees(account.id);
  return rows.some((row) => row.status === "confirmed");
}

/**
 * Ask Safaricom before changing a fee row. Paid is recorded only when the
 * query says so. A prompt that is still open is left pending. Nothing here
 * calls the escrow.
 */
export async function reconcileFeeRow(directory: FeeDirectory, row: FeeRow, now: number, query: FeeQuery): Promise<FeeRow | "unchecked"> {
  if (row.status === "confirmed") return row;
  let verdict: StkQueryResult;
  try {
    verdict = await query(row.checkoutRequestId);
  } catch {
    return "unchecked";
  }
  if (verdict.state === "paid") return confirmFee(directory, row, now, row.mpesaReceipt);
  if (verdict.state === "processing") {
    if (now - row.createdAt >= FEE_PROMPT_TIMEOUT_MS) {
      const updated = await directory.update(row.id, {
        status: "timeout",
        resultDescription: "The prompt timed out before it was approved",
        completedAt: now,
      });
      await directory.noteFeeClosed(row.accountId);
      return updated;
    }
    if (row.status !== "verifying") return directory.update(row.id, { status: "verifying" });
    return row;
  }
  const status = kindFromReason(verdict.reason);
  const updated = await directory.update(row.id, { status, resultDescription: verdict.reason, completedAt: now });
  await directory.noteFeeClosed(row.accountId);
  return updated;
}

async function confirmFee(directory: FeeDirectory, row: FeeRow, now: number, receipt: string | null): Promise<FeeRow> {
  if (row.status === "confirmed") return row;
  if (receipt) {
    const prior = await directory.findByReceipt(receipt);
    if (prior && prior.id !== row.id) {
      const updated = await directory.update(row.id, {
        status: "failed",
        resultDescription: "This M-Pesa receipt is already recorded",
        completedAt: now,
      });
      await directory.noteFeeClosed(row.accountId);
      return updated;
    }
  }
  const updated = await directory.update(row.id, {
    status: "confirmed",
    mpesaReceipt: receipt,
    resultDescription: null,
    completedAt: now,
  });
  await directory.markFeePaid(row.accountId, now);
  return updated;
}

export async function requestPlatformFee(
  directory: FeeDirectory,
  account: FeeAccount,
  now: number,
  amountKes: number,
  query: FeeQuery,
  push: (phone: string, amountKes: number) => Promise<FeePush>,
): Promise<FeeRequestOk | FeeFailure> {
  if (!Number.isInteger(amountKes) || amountKes <= 0) {
    return { ok: false, status: 500, error: "The platform fee amount is not configured" };
  }
  if (await alreadyPaid(directory, account)) {
    return { ok: false, status: 409, error: "The platform fee is already paid" };
  }
  if (!feeIsDue(account)) {
    return { ok: false, status: 409, error: "No platform fee is due for this role" };
  }
  if (!account.phone) {
    return { ok: false, status: 400, error: "Add the M-Pesa number you will pay from first" };
  }
  const phone = normaliseMsisdn(account.phone);
  const rows = await directory.listFees(account.id);
  const open = rows.find((row) => row.status === "pending" || row.status === "verifying");
  if (open && now - open.createdAt < FEE_PUSH_COOLDOWN_MS) {
    return { ok: true, reused: true, checkoutRequestId: open.checkoutRequestId, phone: open.phone, amountKes: open.amountKes, escrowClaim: false };
  }
  if (open) {
    const settled = await reconcileFeeRow(directory, open, now, query);
    if (settled === "unchecked") {
      return { ok: false, status: 503, error: "The earlier prompt could not be checked, so another was not sent." };
    }
    if (settled.status === "confirmed") {
      return { ok: false, status: 409, error: "The platform fee is already paid" };
    }
    if (settled.status === "pending" || settled.status === "verifying") {
      return { ok: false, status: 429, error: "A prompt is still open on that handset. Approve it, or wait for it to expire, before asking again." };
    }
  }
  const pushed = await push(phone, amountKes);
  await directory.insert({
    accountId: account.id,
    phone,
    amountKes,
    checkoutRequestId: pushed.CheckoutRequestID,
    merchantRequestId: pushed.MerchantRequestID,
    status: "pending",
    mpesaReceipt: null,
    resultDescription: null,
    createdAt: now,
    completedAt: null,
  });
  return { ok: true, reused: false, checkoutRequestId: pushed.CheckoutRequestID, phone, amountKes, escrowClaim: false };
}

export interface FeeCallback {
  checkoutRequestId: string;
  resultCode: number;
  resultDesc: string;
  receipt: string | null;
}

/**
 * Idempotent on CheckoutRequestID. A second delivery of the same result
 * does not mark the fee paid twice, and a forged success does not count
 * unless the provider query agrees.
 */
export async function applyFeeCallback(
  directory: FeeDirectory,
  callback: FeeCallback,
  now: number,
  query: FeeQuery,
): Promise<{ ignored: boolean; status: string; escrowClaim: false }> {
  const row = await directory.findByCheckout(callback.checkoutRequestId);
  if (!row) return { ignored: true, status: "missing", escrowClaim: false };
  if (row.status === "confirmed") return { ignored: true, status: "confirmed", escrowClaim: false };
  if (callback.resultCode !== 0) {
    let verdict: StkQueryResult;
    try {
      verdict = await query(row.checkoutRequestId);
    } catch {
      return { ignored: false, status: row.status, escrowClaim: false };
    }
    if (verdict.state === "paid") {
      const paid = await confirmFee(directory, row, now, callback.receipt);
      return { ignored: false, status: paid.status, escrowClaim: false };
    }
    if (verdict.state === "processing") return { ignored: false, status: row.status, escrowClaim: false };
    const status = failureKind(callback.resultCode, callback.resultDesc);
    await directory.update(row.id, { status, resultDescription: callback.resultDesc, completedAt: now });
    await directory.noteFeeClosed(row.accountId);
    return { ignored: false, status, escrowClaim: false };
  }
  const settled = await reconcileFeeRow(directory, { ...row, mpesaReceipt: callback.receipt ?? row.mpesaReceipt }, now, query);
  if (settled === "unchecked") return { ignored: false, status: row.status, escrowClaim: false };
  return { ignored: settled.status === "confirmed" && row.status === "confirmed", status: settled.status, escrowClaim: false };
}

export function memoryFeeDirectory(): FeeDirectory & { rows: FeeRow[]; paid: number[] } {
  const rows: FeeRow[] = [];
  const paid: number[] = [];
  let nextId = 1;
  const directory: FeeDirectory & { rows: FeeRow[]; paid: number[] } = {
    rows,
    paid,
    async listFees(accountId) {
      return rows.filter((row) => row.accountId === accountId).sort((a, b) => b.id - a.id);
    },
    async findByCheckout(checkoutRequestId) {
      return rows.find((row) => row.checkoutRequestId === checkoutRequestId) ?? null;
    },
    async findByReceipt(receipt) {
      return rows.find((row) => row.mpesaReceipt === receipt) ?? null;
    },
    async insert(row) {
      if (rows.some((existing) => existing.checkoutRequestId === row.checkoutRequestId)) {
        throw new Error("checkout already recorded");
      }
      if (row.mpesaReceipt && rows.some((existing) => existing.mpesaReceipt === row.mpesaReceipt)) {
        throw new Error("receipt already recorded");
      }
      const stored = { ...row, id: nextId++ };
      rows.push(stored);
      return stored;
    },
    async update(id, patch) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) throw new Error("no such fee");
      if (patch.mpesaReceipt && rows.some((row) => row.mpesaReceipt === patch.mpesaReceipt && row.id !== id)) {
        throw new Error("receipt already recorded");
      }
      rows[index] = { ...rows[index]!, ...patch };
      return rows[index]!;
    },
    async markFeePaid(accountId, _at) {
      if (!paid.includes(accountId)) paid.push(accountId);
    },
    async noteFeeClosed(_accountId) {},
  };
  return directory;
}
