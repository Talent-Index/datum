import { NextResponse } from "next/server";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { stkPush } from "@/lib/daraja";
import { PROJECT_ID, SITE_NAME, ensureProject } from "@/lib/project";

const bodySchema = z.object({
  phone: z.string().min(9).max(15),
  kes: z.number().int().positive(),
});

/**
 * Sends the Daraja STK push and records the pending payment keyed on the
 * CheckoutRequestID before returning, so the callback — which can arrive
 * before this response is even flushed — always finds its row. Money moves
 * on the callback, never here.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { phone, kes } with a positive integer amount" },
      { status: 400 },
    );
  }
  const { phone, kes } = parsed.data;

  await ensureProject();

  let push;
  try {
    push = await stkPush(phone, kes, "WILLOWPARKA");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "STK push failed" },
      { status: 502 },
    );
  }

  await db().insert(schema.pendingPayments).values({
    checkoutRequestId: push.CheckoutRequestID,
    merchantRequestId: push.MerchantRequestID,
    projectId: PROJECT_ID,
    phone,
    amountKes: kes,
    status: "pending",
  });

  return NextResponse.json({
    ok: true,
    checkoutRequestId: push.CheckoutRequestID,
    sms:
      `Payment request sent to ${phone}. Once confirmed, KES ${kes.toLocaleString("en-US")} ` +
      `is held in escrow for ${SITE_NAME}. It is released to the developer only as ` +
      `construction is verified.`,
  });
}
