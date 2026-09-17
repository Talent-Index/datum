import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { currentSender } from "@/lib/auth";
import { buyerAccount } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { resolveProject } from "@/lib/project";

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
  const session = currentSender(request);
  if (!session) {
    return NextResponse.json({ error: "Verify your phone number first" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Send { commitmentKes }" }, { status: 400 });
  }
  const phone = session.phone;
  const { commitmentKes } = parsed.data;

  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: "Specify ?project=<id>" }, { status: 400 });
  }
  const database = db();
  const address = buyerAccount(phone).address;

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
