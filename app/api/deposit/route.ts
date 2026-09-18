import { NextResponse } from "next/server";
import { z } from "zod";

import { buyerAccount } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { stkPush } from "@/lib/daraja";
import { missingProjectMessage, resolveProject } from "@/lib/project";
import { feeRequired, payerPhone } from "@/lib/accounts";
import { logActivity } from "@/lib/registry";

const bodySchema = z.object({
  kes: z.number().int().positive(),
});

/**
 * Sends the Daraja STK push and records the pending payment keyed on the
 * CheckoutRequestID before returning, so the callback — which can arrive
 * before this response is even flushed — always finds its row. Money moves
 * on the callback, never here.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const payer = await payerPhone(request);
  if (!payer) {
    return NextResponse.json({ error: "Verify your number first, or add the M-Pesa number you will pay from" }, { status: 401 });
  }
  if (payer.account && feeRequired(payer.account)) {
    return NextResponse.json({ error: "Pay the platform fee before paying in" }, { status: 402 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be { kes } with a positive integer" }, { status: 400 });
  }
  const { kes } = parsed.data;
  // The prompt goes to the number the session or the account proves.
  const { phone, account } = payer;

  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: await missingProjectMessage(request) }, { status: 400 });
  }

  let push;
  try {
    push = await stkPush(phone, kes, project.id.toUpperCase());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "STK push failed" },
      { status: 502 },
    );
  }

  await db().insert(schema.pendingPayments).values({
    checkoutRequestId: push.CheckoutRequestID,
    merchantRequestId: push.MerchantRequestID,
    projectId: project.id,
    accountId: account?.id ?? null,
    phone,
    amountKes: kes,
    status: "pending",
  });

  await logActivity({
    accountId: account?.id ?? null,
    actorAddress: (account?.address as `0x${string}` | undefined) ?? buyerAccount(phone).address,
    kind: "deposit.requested",
    payload: { project: project.id, kes, checkoutRequestId: push.CheckoutRequestID },
  });

  return NextResponse.json({
    ok: true,
    checkoutRequestId: push.CheckoutRequestID,
    sms:
      `Payment request sent to ${phone}. Once confirmed, KES ${kes.toLocaleString("en-US")} ` +
      `is held in escrow for ${project.name}. It is released to the developer only as ` +
      `construction is verified.`,
  });
}
