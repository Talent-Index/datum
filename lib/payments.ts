import { and, eq } from "drizzle-orm";
import type { Address } from "viem";

import {
  KES_UNITS,
  WRITE_GAS,
  buyerAccount,
  escrowAbi,
  normaliseMsisdn,
  platformWallet,
  publicClient,
  revertReason,
} from "./chain";
import { stkQuery } from "./daraja";
import { db, schema } from "./db";
import { logActivity } from "./registry";
import { getProject } from "./project";

/**
 * Turning a confirmed M-Pesa payment into an escrow deposit.
 *
 * Shared by the callback and the replay so they cannot drift: both verify
 * the payment with Safaricom over our own authenticated channel before any
 * money is credited, because the callback endpoint is public and unsigned.
 */

export type CreditOutcome =
  | { status: "confirmed"; txHash: string }
  | { status: "verifying" }
  | { status: "failed"; reason: string }
  | { status: "skipped"; reason: string };

export async function creditPayment(paymentId: number, receipt?: string): Promise<CreditOutcome> {
  const database = db();
  const [payment] = await database
    .select()
    .from(schema.pendingPayments)
    .where(eq(schema.pendingPayments.id, paymentId));
  if (!payment) return { status: "skipped", reason: "no such payment" };
  if (payment.status === "confirmed") return { status: "skipped", reason: "already credited" };

  const verdict = await stkQuery(payment.checkoutRequestId);
  if (verdict.state === "processing") {
    await database
      .update(schema.pendingPayments)
      .set({ status: "verifying" })
      .where(eq(schema.pendingPayments.id, paymentId));
    return { status: "verifying" };
  }
  if (verdict.state === "failed") {
    await database
      .update(schema.pendingPayments)
      .set({ status: "failed", resultDescription: verdict.reason, completedAt: new Date() })
      .where(eq(schema.pendingPayments.id, paymentId));
    return { status: "failed", reason: verdict.reason };
  }

  if (payment.purpose === "fee") return creditFee(paymentId, payment, receipt);

  if (!payment.projectId) return { status: "failed", reason: "deposit has no project" };
  const project = await getProject(payment.projectId);
  if (!project) return { status: "failed", reason: `project ${payment.projectId} not found` };

  // A buyer who registered already has a wallet; re-deriving would strand
  // this instalment at a second address. Derivation is only for a buyer
  // paying without registering first.
  const phone = normaliseMsisdn(payment.phone);
  const existing = await database
    .select({ walletAddress: schema.buyers.walletAddress })
    .from(schema.buyers)
    .where(and(eq(schema.buyers.projectId, project.id), eq(schema.buyers.phone, phone)));
  const [holderRow] = payment.accountId
    ? await database.select().from(schema.accounts).where(eq(schema.accounts.id, payment.accountId))
    : [];
  const walletAddress = (existing[0]?.walletAddress ??
    holderRow?.address ??
    buyerAccount(phone).address) as Address;
  if (!existing.length) {
    await database
      .insert(schema.buyers)
      .values({ projectId: project.id, phone, walletAddress })
      .onConflictDoNothing();
  }

  try {
    const { client, account } = platformWallet();
    const hash = await client.writeContract({
      address: project.contractAddress,
      abi: escrowAbi,
      functionName: "depositFor",
      args: [walletAddress, BigInt(payment.amountKes) * KES_UNITS],
      account,
      chain: client.chain,
      gas: WRITE_GAS,
    });
    await publicClient().waitForTransactionReceipt({ hash });
    await database
      .update(schema.pendingPayments)
      .set({
        status: "confirmed",
        mpesaReceipt: receipt ?? payment.mpesaReceipt,
        depositTxHash: hash,
        completedAt: new Date(),
      })
      .where(eq(schema.pendingPayments.id, paymentId));
    const [holder] = holderRow
      ? [holderRow]
      : await database.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.phone, phone));
    await logActivity({
      accountId: holder?.id ?? null,
      actorAddress: walletAddress,
      kind: "deposit.confirmed",
      payload: { project: project.id, kes: payment.amountKes, receipt: receipt ?? payment.mpesaReceipt, depositTx: hash },
    });
    return { status: "confirmed", txHash: hash };
  } catch (error) {
    // The M-Pesa money is in; the claim is not. Record it for replay rather
    // than dropping it — this is the case the replay endpoint exists for.
    const reason = `deposit transaction failed: ${revertReason(error)}`;
    await database
      .update(schema.pendingPayments)
      .set({ status: "failed", resultDescription: reason, mpesaReceipt: receipt ?? payment.mpesaReceipt })
      .where(eq(schema.pendingPayments.id, paymentId));
    return { status: "failed", reason };
  }
}

type PendingPayment = typeof schema.pendingPayments.$inferSelect;

/**
 * A platform fee, confirmed by Safaricom, marks the account paid and proves
 * the number it came from. Nothing goes to escrow; the record goes on chain.
 */
async function creditFee(paymentId: number, payment: PendingPayment, receipt?: string): Promise<CreditOutcome> {
  const database = db();
  if (!payment.accountId) return { status: "failed", reason: "fee has no account" };
  const [account] = await database.select().from(schema.accounts).where(eq(schema.accounts.id, payment.accountId));
  if (!account) return { status: "failed", reason: `account ${payment.accountId} not found` };

  await database
    .update(schema.accounts)
    .set({ feeStatus: "paid", feePaidAt: new Date(), phoneVerified: true, phone: normaliseMsisdn(payment.phone) })
    .where(eq(schema.accounts.id, account.id));
  await database
    .update(schema.pendingPayments)
    .set({ status: "confirmed", mpesaReceipt: receipt ?? payment.mpesaReceipt, completedAt: new Date() })
    .where(eq(schema.pendingPayments.id, paymentId));
  const logged = await logActivity({
    accountId: account.id,
    actorAddress: account.address as Address,
    kind: "fee.paid",
    payload: { kes: payment.amountKes, receipt: receipt ?? payment.mpesaReceipt, phone: normaliseMsisdn(payment.phone) },
  });
  return { status: "confirmed", txHash: logged.txHash ?? "" };
}
