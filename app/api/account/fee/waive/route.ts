import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { accountById } from "@/lib/accounts";
import { platformWallet } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { logActivity } from "@/lib/registry";

const bodySchema = z.object({
  accountId: z.number().int().positive(),
  reason: z.string().trim().min(3).max(300),
});

/**
 * Staff mark a fee settled outside M-Pesa: paid in cash at a visit, or
 * waived. Operator only, with a reason that goes on chain with the record.
 * The number is not proven by this path, and stays marked so.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isOperator(request)) return NextResponse.json({ error: "Operator access required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Body must be { accountId, reason }" }, { status: 400 });
  const account = await accountById(parsed.data.accountId);
  if (!account) return NextResponse.json({ error: "No such account" }, { status: 404 });
  if (account.feeStatus === "paid") return NextResponse.json({ error: "The fee is already paid" }, { status: 409 });
  await db()
    .update(schema.accounts)
    .set({ feeStatus: "paid", feePaidAt: new Date() })
    .where(eq(schema.accounts.id, account.id));
  await logActivity({
    accountId: account.id,
    actorAddress: platformWallet().account.address,
    kind: "fee.waived",
    payload: { subject: account.address, reason: parsed.data.reason },
  });
  return NextResponse.json({ ok: true, message: `${account.displayName}'s fee is marked settled: ${parsed.data.reason}` });
}
