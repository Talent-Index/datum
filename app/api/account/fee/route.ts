import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";

import { currentAccount, feeRequired, listingFeeKes } from "@/lib/accounts";
import { db, schema } from "@/lib/db";
import { stkPush } from "@/lib/daraja";
import { logActivity } from "@/lib/registry";

/**
 * The platform fee: one M-Pesa prompt to the account's number. Sellers,
 * developers and companies pay it before they can post; a sender pays it
 * before they can commit. Confirmation comes through the same callback as
 * a deposit and marks the account paid and its number proven.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  if (!feeRequired(account)) {
    return NextResponse.json({ error: account.feeStatus === "paid" ? "The fee is already paid" : "No fee is due for this role" }, { status: 409 });
  }
  if (!account.phone) {
    return NextResponse.json({ error: "Add the M-Pesa number you will pay from first" }, { status: 400 });
  }
  const database = db();
  const [recent] = await database
    .select({ id: schema.pendingPayments.id })
    .from(schema.pendingPayments)
    .where(
      and(
        eq(schema.pendingPayments.accountId, account.id),
        eq(schema.pendingPayments.purpose, "fee"),
        eq(schema.pendingPayments.status, "pending"),
        gt(schema.pendingPayments.createdAt, new Date(Date.now() - 90 * 1000)),
      ),
    );
  if (recent) {
    return NextResponse.json({ error: "A prompt was sent less than 90 seconds ago; approve it on your handset" }, { status: 429 });
  }

  const kes = listingFeeKes();
  let push;
  try {
    push = await stkPush(account.phone, kes, "DATUMFEE");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "STK push failed" }, { status: 502 });
  }
  await database.insert(schema.pendingPayments).values({
    checkoutRequestId: push.CheckoutRequestID,
    merchantRequestId: push.MerchantRequestID,
    purpose: "fee",
    projectId: null,
    accountId: account.id,
    phone: account.phone,
    amountKes: kes,
    status: "pending",
  });
  await database.update(schema.accounts).set({ feeStatus: "pending" }).where(eq(schema.accounts.id, account.id));
  await logActivity({
    accountId: account.id,
    actorAddress: account.address as `0x${string}`,
    kind: "fee.requested",
    payload: { kes, checkoutRequestId: push.CheckoutRequestID },
  });
  return NextResponse.json({
    ok: true,
    checkoutRequestId: push.CheckoutRequestID,
    message: `Prompt sent to ${account.phone} for KES ${kes.toLocaleString("en-US")}. Approve it on the handset; this page updates once Safaricom confirms.`,
  });
}
