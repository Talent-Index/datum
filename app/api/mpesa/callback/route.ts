import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { callbackSchema } from "@/lib/daraja";
import { db, schema } from "@/lib/db";
import { creditPayment } from "@/lib/payments";

/**
 * Daraja confirmation. Safaricom retries deliveries, so this handler is
 * idempotent on CheckoutRequestID: only a row still in 'pending' is acted
 * on, and every delivery is acknowledged with ResultCode 0 — a non-zero
 * acknowledgement only triggers more retries, never a correction.
 *
 * The endpoint is public and unsigned, so a success here is a claim, not a
 * fact. Nothing is credited until creditPayment has asked Safaricom directly.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ack = NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });

  const parsed = callbackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    console.error("[mpesa/callback] unrecognised payload shape");
    return ack;
  }
  const callback = parsed.data.Body.stkCallback;

  const database = db();
  const rows = await database
    .select()
    .from(schema.pendingPayments)
    .where(eq(schema.pendingPayments.checkoutRequestId, callback.CheckoutRequestID));
  const payment = rows[0];
  if (!payment) {
    console.error(
      `[mpesa/callback] no pending payment for ${callback.CheckoutRequestID}; ignoring`,
    );
    return ack;
  }
  if (payment.status !== "pending") {
    return ack; // retry of an already-processed delivery
  }

  if (callback.ResultCode !== 0) {
    await database
      .update(schema.pendingPayments)
      .set({
        status: "failed",
        resultDescription: callback.ResultDesc,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.pendingPayments.id, payment.id),
          eq(schema.pendingPayments.status, "pending"),
        ),
      );
    return ack;
  }

  const receipt = callback.CallbackMetadata?.Item.find(
    (item: { Name: string; Value?: string | number }) => item.Name === "MpesaReceiptNumber",
  )?.Value;

  const outcome = await creditPayment(payment.id, typeof receipt === "string" ? receipt : undefined);
  if (outcome.status === "failed") {
    console.error(`[mpesa/callback] ${payment.checkoutRequestId}: ${outcome.reason}`);
  }
  return ack;
}
