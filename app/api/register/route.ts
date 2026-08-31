import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { buyerAccount, normaliseMsisdn } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { PROJECT_ID, SITE_NAME, ensureProject } from "@/lib/project";

/**
 * A buyer signs up with a phone number and what they undertake to pay in
 * total. No money moves here and no key is issued to them: registration
 * reserves the managed wallet their deposits and refunds will use, so the
 * ledger can measure instalments against a commitment from the first
 * payment onward.
 */
const bodySchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^(?:\+?254|0)7\d{8}$/, "Enter a Safaricom number such as 0712345678"),
  commitmentKes: z.number().int().positive().max(1_000_000_000),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Send { phone, commitmentKes }" },
      { status: 400 },
    );
  }
  const phone = normaliseMsisdn(parsed.data.phone);
  const { commitmentKes } = parsed.data;

  await ensureProject();
  const database = db();
  const address = buyerAccount(phone).address;

  const existing = await database
    .select({ id: schema.buyers.id, walletAddress: schema.buyers.walletAddress })
    .from(schema.buyers)
    .where(eq(schema.buyers.phone, phone));

  if (existing.length) {
    // Re-registering revises the commitment rather than creating a second
    // buyer; the wallet is derived from the number, so it does not move.
    await database
      .update(schema.buyers)
      .set({ commitmentKes })
      .where(eq(schema.buyers.phone, phone));
  } else {
    await database.insert(schema.buyers).values({
      projectId: PROJECT_ID,
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
      `${phone} registered for ${SITE_NAME} with a commitment of ` +
      `KES ${commitmentKes.toLocaleString("en-US")}. Deposit in instalments; ` +
      `each one is held in escrow and released only against verified construction.`,
  });
}
