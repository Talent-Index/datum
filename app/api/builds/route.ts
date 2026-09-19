import { NextResponse } from "next/server";
import { desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { accountById, currentAccount, feeRequired } from "@/lib/accounts";
import { buildById, initialDepositFor, publicBuild, requestInitialDeposit } from "@/lib/builds";
import { db, schema } from "@/lib/db";
import { logActivity } from "@/lib/registry";

/**
 * Build requests: someone who wants a house built comes to Datum first.
 * Any account with a number can ask; senders pay the platform fee first.
 * Creating the request sends the M-Pesa prompt for the initial deposit.
 */
const bodySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,40}$/, "id: 3-40 lowercase letters, digits, hyphens"),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2000),
  locationName: z.string().trim().min(2).max(120),
  latitude: z.number().min(-5).max(5),
  longitude: z.number().min(33).max(42),
  budgetKes: z.number().int().min(50_000).max(2_000_000_000),
});

async function withParties(b: typeof schema.buildRequests.$inferSelect) {
  const [owner, builder, trustee] = await Promise.all([
    accountById(b.ownerAccountId),
    b.builderAccountId ? accountById(b.builderAccountId) : null,
    b.trusteeAccountId ? accountById(b.trusteeAccountId) : null,
  ]);
  return publicBuild(b, { owner, builder, trustee });
}

export async function GET(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  const reviewer = isOperator(request) || account?.role === "trustee";
  const scope = new URL(request.url).searchParams.get("scope");
  const database = db();
  let rows: Array<typeof schema.buildRequests.$inferSelect>;
  if (scope === "all" && reviewer) {
    rows = await database.select().from(schema.buildRequests).orderBy(desc(schema.buildRequests.createdAt)).limit(200);
  } else if (scope === "open" && reviewer) {
    rows = await database
      .select()
      .from(schema.buildRequests)
      .where(inArray(schema.buildRequests.status, ["requested", "deposit_paid", "proposed"]))
      .orderBy(desc(schema.buildRequests.createdAt));
  } else if (account) {
    rows = await database
      .select()
      .from(schema.buildRequests)
      .where(or(eq(schema.buildRequests.ownerAccountId, account.id), eq(schema.buildRequests.builderAccountId, account.id)))
      .orderBy(desc(schema.buildRequests.createdAt));
  } else {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }
  return NextResponse.json({ builds: await Promise.all(rows.map(withParties)) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  if (!["buyer", "sender"].includes(account.role)) {
    return NextResponse.json({ error: "Build requests come from buyers and senders; builders are assigned by Datum" }, { status: 403 });
  }
  if (feeRequired(account)) return NextResponse.json({ error: "Pay the platform fee first" }, { status: 402 });
  if (!account.phone) return NextResponse.json({ error: "Add the M-Pesa number you will pay from first" }, { status: 400 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const input = parsed.data;
  if (await buildById(input.id)) return NextResponse.json({ error: `'${input.id}' is already taken` }, { status: 409 });

  const initialDepositKes = initialDepositFor(input.budgetKes);
  const [row] = await db()
    .insert(schema.buildRequests)
    .values({
      id: input.id,
      ownerAccountId: account.id,
      title: input.title,
      description: input.description,
      locationName: input.locationName,
      latitude: input.latitude,
      longitude: input.longitude,
      budgetKes: input.budgetKes,
      initialDepositKes,
    })
    .returning();
  await logActivity({
    accountId: account.id,
    actorAddress: account.address as `0x${string}`,
    kind: "build.requested",
    payload: { build: input.id, budgetKes: input.budgetKes, initialDepositKes },
  });

  let prompt: string;
  try {
    const push = await requestInitialDeposit(row!, account);
    prompt = `Prompt sent to ${account.phone} for the KES ${initialDepositKes.toLocaleString("en-US")} initial deposit (${push.checkoutRequestId}).`;
  } catch (error) {
    prompt = `The deposit prompt could not be sent: ${error instanceof Error ? error.message : String(error)}. Send it again from your build page.`;
  }
  return NextResponse.json({
    ok: true,
    id: input.id,
    initialDepositKes,
    message: `Request recorded. ${prompt} Once it arrives, Datum staff propose a builder, a trustee and the milestones for you to sign.`,
  });
}
