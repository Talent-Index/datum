import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { accountByPhone, createAccount, publicAccount, friendlyError } from "@/lib/accounts";
import { db, schema } from "@/lib/db";

/** Trustees on the platform. Anyone can see who they are. */
export async function GET(): Promise<NextResponse> {
  const rows = await db().select().from(schema.accounts).where(eq(schema.accounts.role, "trustee"));
  return NextResponse.json({ trustees: rows.map(publicAccount) });
}

const bodySchema = z.object({
  phone: z.string().trim().regex(/^(?:\+?254|0)7\d{8}$/, "Enter a Safaricom number such as 0712345678"),
  displayName: z.string().trim().min(2).max(80),
});

/**
 * Appoint a trustee. Operator only: a trustee holds the second signature on
 * every escrow assigned to them and passes identity checks, so this is the
 * platform vouching for a person, not a sign-up.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isOperator(request)) return NextResponse.json({ error: "Operator access required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid trustee" }, { status: 400 });
  }
  if (await accountByPhone(parsed.data.phone)) {
    return NextResponse.json({ error: "That number already has an account; a trustee must be appointed on a fresh number" }, { status: 409 });
  }
  try {
    const account = await createAccount({ subject: parsed.data.phone, role: "trustee", displayName: parsed.data.displayName });
    return NextResponse.json({ ok: true, trustee: publicAccount(account), message: `${account.displayName} appointed as trustee at ${account.address}.` });
  } catch (error) {
    return NextResponse.json({ error: friendlyError(error, "Could not appoint the trustee; try again") }, { status: 400 });
  }
}
