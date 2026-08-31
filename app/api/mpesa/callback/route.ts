import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import {
  KES_UNITS,
  buyerAccount,
  escrowAbi,
  escrowAddress,
  platformWallet,
  publicClient,
  revertReason,
  WRITE_GAS,
} from "@/lib/chain";
import { callbackSchema } from "@/lib/daraja";
import { db, schema } from "@/lib/db";

/**
 * Daraja confirmation. Safaricom retries deliveries, so this handler is
 * idempotent on CheckoutRequestID: only a row still in 'pending' is acted
 * on, and every delivery is acknowledged with ResultCode 0 — a non-zero
 * acknowledgement only triggers more retries, never a correction.
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

  const account = buyerAccount(payment.phone);
  await database
    .insert(schema.buyers)
    .values({
      projectId: payment.projectId,
      phone: payment.phone,
      walletAddress: account.address,
    })
    .onConflictDoNothing();

  try {
    const { client, account: platform } = platformWallet();
    const hash = await client.writeContract({
      address: escrowAddress(),
      abi: escrowAbi,
      functionName: "depositFor",
      args: [account.address, BigInt(payment.amountKes) * KES_UNITS],
      account: platform,
      chain: client.chain,
      gas: WRITE_GAS,
    });
    await publicClient().waitForTransactionReceipt({ hash });

    await database
      .update(schema.pendingPayments)
      .set({
        status: "confirmed",
        mpesaReceipt: typeof receipt === "string" ? receipt : null,
        depositTxHash: hash,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.pendingPayments.id, payment.id),
          eq(schema.pendingPayments.status, "pending"),
        ),
      );
  } catch (error) {
    // The M-Pesa money is in; the claim is not. The row records the failure
    // so operations can replay the deposit — never drop it silently.
    await database
      .update(schema.pendingPayments)
      .set({
        status: "failed",
        resultDescription: `deposit transaction failed: ${revertReason(error)}`,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.pendingPayments.id, payment.id),
          eq(schema.pendingPayments.status, "pending"),
        ),
      );
    console.error(`[mpesa/callback] depositFor failed: ${revertReason(error)}`);
  }

  return ack;
}
