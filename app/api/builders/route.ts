import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { isOperator } from "@/lib/auth";
import { canReview, currentAccount } from "@/lib/accounts";
import { db, schema } from "@/lib/db";

/** Verified developers and companies staff can assign to a build. */
export async function GET(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!canReview(account, isOperator(request))) return NextResponse.json({ error: "Trustee or operator access required" }, { status: 401 });
  const rows = await db()
    .select({ id: schema.accounts.id, name: schema.accounts.displayName, company: schema.accounts.companyName, role: schema.accounts.role, address: schema.accounts.address })
    .from(schema.accounts)
    .where(and(inArray(schema.accounts.role, ["developer", "company"]), eq(schema.accounts.kycStatus, "verified")));
  return NextResponse.json({ builders: rows });
}
