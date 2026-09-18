import { NextResponse } from "next/server";
import { inArray, lt, or, and, eq } from "drizzle-orm";

import { isOperator } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { creditPayment } from "@/lib/payments";
import { replayActivities } from "@/lib/registry";

/**
 * Finish payments the callback could not.
 *
 * Three ways a paid instalment can be left short of escrow: the chain
 * transaction failed after M-Pesa confirmed, Safaricom's status query was
 * still "processing" when the callback arrived, or the callback never came
 * at all. Each is re-checked against Safaricom and credited if paid. Then
 * every activity whose registry write failed is written again. Runs from
 * the Vercel cron and on demand by an operator.
 */
const STALE_MINUTES = 3;

function authorised(request: Request): boolean {
  const cron = process.env.CRON_SECRET;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return (!!cron && bearer === cron) || isOperator(request);
}

async function replay(): Promise<Record<string, unknown>> {
  const database = db();
  const candidates = await database
    .select({ id: schema.pendingPayments.id, checkoutRequestId: schema.pendingPayments.checkoutRequestId, status: schema.pendingPayments.status })
    .from(schema.pendingPayments)
    .where(
      or(
        inArray(schema.pendingPayments.status, ["verifying"]),
        and(
          eq(schema.pendingPayments.status, "failed"),
          // only chain failures are worth replaying; a declined push stays declined
          lt(schema.pendingPayments.completedAt, new Date()),
        ),
        and(
          eq(schema.pendingPayments.status, "pending"),
          lt(schema.pendingPayments.createdAt, new Date(Date.now() - STALE_MINUTES * 60 * 1000)),
        ),
      ),
    );

  const results: Array<{ id: string; before: string; after: string }> = [];
  for (const c of candidates) {
    const [row] = await database
      .select({ reason: schema.pendingPayments.resultDescription })
      .from(schema.pendingPayments)
      .where(eq(schema.pendingPayments.id, c.id));
    if (c.status === "failed" && !row?.reason?.startsWith("deposit transaction failed")) continue;
    const outcome = await creditPayment(c.id);
    results.push({ id: c.checkoutRequestId, before: c.status, after: outcome.status });
  }
  const activities = await replayActivities();
  return { checked: candidates.length, results, activities };
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Operator or cron access required" }, { status: 401 });
  }
  return NextResponse.json(await replay());
}

/** Vercel cron calls with GET. */
export async function GET(request: Request): Promise<NextResponse> {
  return POST(request);
}
