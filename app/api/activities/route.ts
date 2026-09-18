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
