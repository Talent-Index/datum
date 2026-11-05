import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { currentAccount, listingFeeKes } from "@/lib/accounts";
import { stkPush, stkQuery } from "@/lib/daraja";
import { db, schema } from "@/lib/db";
import { dbFeeDirectory } from "@/lib/onboarding/db";
import { reconcileFeeRow, requestPlatformFee } from "@/lib/onboarding/fee";
import { logActivity } from "@/lib/registry";

/**
 * The platform fee: one M-Pesa prompt to the number saved on this account.
 * Sellers, developers, companies and senders pay it before they post or
 * commit. Buyers are not charged. The prompt is sent only from this POST,
 * never when the page loads. A paid fee is not an escrow deposit and does
 * not verify the handset.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  const amount = listingFeeKes();
  let result;
  try {
    result = await requestPlatformFee(
    dbFeeDirectory(),
    { id: account.id, role: account.role, feeStatus: account.feeStatus, phone: account.phone },
    Date.now(),
    amount,
    (checkoutRequestId) => stkQuery(checkoutRequestId),
    async (phone, kes) => {
      const push = await stkPush(phone, kes, "DATUMFEE", "Platform fee");
      return { CheckoutRequestID: push.CheckoutRequestID, MerchantRequestID: push.MerchantRequestID };
    },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "STK push failed" }, { status: 502 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (!result.reused) {
    await db().update(schema.accounts).set({ feeStatus: "pending" }).where(eq(schema.accounts.id, account.id));
    await logActivity({
      accountId: account.id,
      actorAddress: account.address as `0x${string}`,
      kind: "fee.requested",
      payload: { kes: result.amountKes, checkoutRequestId: result.checkoutRequestId },
    });
  }
  return NextResponse.json({
    ok: true,
    reused: result.reused,
    checkoutRequestId: result.checkoutRequestId,
    amountKes: result.amountKes,
    phone: result.phone,
    escrowClaim: false,
    message: result.reused
      ? `A prompt for KES ${result.amountKes.toLocaleString("en-US")} is already open on ${result.phone}. Approve it on the handset. Another prompt was not sent.`
      : `Prompt sent to ${result.phone} for KES ${result.amountKes.toLocaleString("en-US")}. Approve it on the handset. This page updates when Safaricom confirms.`,
  });
}

/** Re-check the latest fee prompt with Safaricom. Does not send a new one. */
export async function GET(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  const [row] = await db()
    .select()
    .from(schema.pendingPayments)
    .where(and(eq(schema.pendingPayments.accountId, account.id), eq(schema.pendingPayments.purpose, "fee")))
    .orderBy(desc(schema.pendingPayments.id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ payment: null, fee_status: account.feeStatus });
  }
  if (row.status === "pending" || row.status === "verifying") {
    const directory = dbFeeDirectory();
    const current = await directory.findByCheckout(row.checkoutRequestId);
    if (current) {
      try {
        await reconcileFeeRow(directory, current, Date.now(), (id) => stkQuery(id));
      } catch {
        // Leave the row as it is. An unreachable provider is not a payment.
      }
    }
  }
  const [fresh] = await db().select().from(schema.pendingPayments).where(eq(schema.pendingPayments.id, row.id));
  const [updated] = await db().select().from(schema.accounts).where(eq(schema.accounts.id, account.id));
  return NextResponse.json({
    fee_status: updated?.feeStatus ?? account.feeStatus,
    payment: fresh
      ? {
          status: fresh.status,
          amount_kes: fresh.amountKes,
          phone: fresh.phone,
          checkout_request_id: fresh.checkoutRequestId,
          reason: fresh.resultDescription,
          created_at: fresh.createdAt,
        }
      : null,
  });
}
