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
  const walletAddress = (existing[0]?.walletAddress ?? buyerAccount(phone).address) as Address;
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
    const [holder] = await database
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.phone, phone));
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
