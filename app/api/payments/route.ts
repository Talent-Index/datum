import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { payerPhone } from "@/lib/accounts";
import { db, schema } from "@/lib/db";

/**
 * M-Pesa prompts for the signed-in number. Amounts and statuses come from
 * the payment rows, not from the screen.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const payer = await payerPhone(request);
  if (!payer) return NextResponse.json({ payments: [] });
  const project = new URL(request.url).searchParams.get("project");
  const filters = [eq(schema.pendingPayments.phone, payer.phone)];
  if (project) filters.push(eq(schema.pendingPayments.projectId, project));
  const rows = await db()
    .select({
      amount_kes: schema.pendingPayments.amountKes,
      status: schema.pendingPayments.status,
      purpose: schema.pendingPayments.purpose,
      created_at: schema.pendingPayments.createdAt,
      result: schema.pendingPayments.resultDescription,
      deposit_tx: schema.pendingPayments.depositTxHash,
      project_id: schema.pendingPayments.projectId,
    })
    .from(schema.pendingPayments)
    .where(and(...filters))
    .orderBy(desc(schema.pendingPayments.id))
    .limit(8);
  return NextResponse.json({ payments: rows });
}
