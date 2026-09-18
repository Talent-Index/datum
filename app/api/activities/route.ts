import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { isOperator } from "@/lib/auth";
import { currentAccount } from "@/lib/accounts";
import { db, schema } from "@/lib/db";

/**
 * The activity record. A person sees their own; a trustee or the operator
 * sees everyone's. Each row carries the hash written to the registry and
 * the transaction that carried it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const address = new URL(request.url).searchParams.get("address");
  if (address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return NextResponse.json({ error: "Not an address" }, { status: 400 });
    // Public trace: what kind of thing happened, when, and the proof. The
    // payload stays private; a receipt number or an amount is not for
    // anyone who types in an address.
    const rows = await db()
      .select({
        id: schema.activities.id,
        kind: schema.activities.kind,
        hash: schema.activities.payloadHash,
        tx: schema.activities.txHash,
        at: schema.activities.createdAt,
      })
      .from(schema.activities)
      .where(eq(schema.activities.actorAddress, address))
      .orderBy(desc(schema.activities.id))
      .limit(200);
    const [holder] = await db()
      .select({ role: schema.accounts.role, kyc: schema.accounts.kycStatus, since: schema.accounts.createdAt })
      .from(schema.accounts)
      .where(eq(schema.accounts.address, address));
    return NextResponse.json({ address, holder: holder ?? null, activities: rows });
  }
  const account = await currentAccount(request);
  const all = isOperator(request) || account?.role === "trustee";
  const wantAll = new URL(request.url).searchParams.get("scope") === "all";
  if (!account && !all) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const database = db();
  const base = database
    .select({
      id: schema.activities.id,
      account_id: schema.activities.accountId,
      actor: schema.activities.actorAddress,
      kind: schema.activities.kind,
      payload: schema.activities.payload,
      hash: schema.activities.payloadHash,
      tx: schema.activities.txHash,
      error: schema.activities.error,
      at: schema.activities.createdAt,
    })
    .from(schema.activities);
  const rows =
    all && wantAll
      ? await base.orderBy(desc(schema.activities.id)).limit(100)
      : await base.where(eq(schema.activities.accountId, account!.id)).orderBy(desc(schema.activities.id)).limit(100);
  return NextResponse.json({ activities: rows });
}
