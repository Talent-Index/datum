import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { buyerAccount } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { missingProjectMessage, resolveProject } from "@/lib/project";
import { feeRequired, payerPhone } from "@/lib/accounts";
import { logActivity } from "@/lib/registry";

/**
 * A buyer signs up with a phone number and what they undertake to pay in
 * total. No money moves here and no key is issued to them: registration
 * reserves the managed wallet their deposits and refunds will use, so the
 * ledger can measure instalments against a commitment from the first
 * payment onward.
 */
const bodySchema = z.object({
  commitmentKes: z.number().int().positive().max(1_000_000_000),
});

export async function POST(request: Request): Promise<NextResponse> {
  // The number is whatever the session proves, never what the body claims:
  // a commitment in someone else's name is the fraud this exists to stop.
  const payer = await payerPhone(request);
  if (!payer) {
    return NextResponse.json({ error: "Verify your number first, or add the M-Pesa number you will pay from" }, { status: 401 });
  }
  if (payer.account && feeRequired(payer.account)) {
    return NextResponse.json({ error: "Pay the platform fee before committing" }, { status: 402 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Send { commitmentKes }" }, { status: 400 });
  }
  const { phone, account } = payer;
  const { commitmentKes } = parsed.data;

  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: await missingProjectMessage(request) }, { status: 400 });
  }
  const database = db();
  // An email account's money lives at its own address, not one derived
  // from whatever number it happens to pay from.
  const address = (account?.address as `0x${string}` | undefined) ?? buyerAccount(phone).address;

  const existing = await database
    .select({ id: schema.buyers.id, walletAddress: schema.buyers.walletAddress })
    .from(schema.buyers)
    .where(and(eq(schema.buyers.projectId, project.id), eq(schema.buyers.phone, phone)));

  if (existing.length) {
    // Re-registering revises the commitment rather than creating a second
    // buyer; the wallet is derived from the number, so it does not move.
    await database
      .update(schema.buyers)
      .set({ commitmentKes })
      .where(and(eq(schema.buyers.projectId, project.id), eq(schema.buyers.phone, phone)));
  } else {
    await database.insert(schema.buyers).values({
      projectId: project.id,
      phone,
      walletAddress: address,
      commitmentKes,
    });
  }

  await logActivity({
    accountId: account?.id ?? null,
    actorAddress: (existing[0]?.walletAddress ?? address) as `0x${string}`,
    kind: "commitment.registered",
    payload: { project: project.id, commitmentKes },
  });

  // Report the wallet the buyer's money is actually in. A returning buyer
  // keeps the address their earlier instalments were paid to.
  return NextResponse.json({
    ok: true,
    phone,
    address: existing[0]?.walletAddress ?? address,
    commitmentKes,
    message:
      `${phone} registered for ${project.name} with a commitment of ` +
      `KES ${commitmentKes.toLocaleString("en-US")}. Deposit in instalments; ` +
      `each one is held in escrow and released only against verified construction.`,
  });
}
