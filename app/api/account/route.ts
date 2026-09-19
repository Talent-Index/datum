import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { currentSender } from "@/lib/auth";
import { createAccount, currentAccount, ensureRegistered, publicAccount, friendlyError } from "@/lib/accounts";
import { db, schema } from "@/lib/db";
import { SELF_SERVICE_ROLES } from "@/lib/registry";

/**
 * The signed-in person's account: who they are here, their address, where
 * their identity check stands, their listings and commitments.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const session = currentSender(request);
  if (!session) return NextResponse.json({ session: null, account: null });
  let account = await currentAccount(request);
  const who = { subject: session.subject, phone: session.phone, email: session.email };
  if (!account) return NextResponse.json({ session: who, account: null });
  account = await ensureRegistered(account);
  const database = db();

  const [kyc] = await database
    .select()
    .from(schema.kycSubmissions)
    .where(eq(schema.kycSubmissions.accountId, account.id))
    .orderBy(desc(schema.kycSubmissions.id))
    .limit(1);
  const listings = await database
    .select()
    .from(schema.listings)
    .where(eq(schema.listings.ownerAccountId, account.id))
    .orderBy(desc(schema.listings.createdAt));
  const commitments = await database
    .select({
      project_id: schema.buyers.projectId,
      commitment: schema.buyers.commitmentKes,
      wallet: schema.buyers.walletAddress,
      name: schema.projects.name,
    })
    .from(schema.buyers)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.buyers.projectId))
    .where(eq(schema.buyers.walletAddress, account.address));
  const trusteeOf =
    account.role === "trustee"
      ? await database
          .select({ id: schema.projects.id, name: schema.projects.name })
          .from(schema.projects)
          .where(eq(schema.projects.trusteeAccountId, account.id))
      : [];

  const [fee] = await database
    .select({ status: schema.pendingPayments.status, created_at: schema.pendingPayments.createdAt, reason: schema.pendingPayments.resultDescription })
    .from(schema.pendingPayments)
    .where(and(eq(schema.pendingPayments.accountId, account.id), eq(schema.pendingPayments.purpose, "fee")))
    .orderBy(desc(schema.pendingPayments.id))
    .limit(1);

  return NextResponse.json({
    session: who,
    account: publicAccount(account),
    fee_payment: fee ?? null,
    kyc: kyc
      ? {
          id: kyc.id,
          status: kyc.status,
          full_name: kyc.fullName,
          id_type: kyc.idType,
          id_last4: kyc.idLast4,
          document: kyc.documentName,
          document_sha256: kyc.documentSha256,
          note: kyc.reviewNote,
          tx: kyc.txHash,
          submitted_at: kyc.createdAt,
        }
      : null,
    listings: listings.map((l) => ({
      id: l.id,
      kind: l.kind,
      title: l.title,
      status: l.status,
      price_kes: l.priceKes,
      project_id: l.projectId,
      note: l.reviewNote,
      tx: l.txHash,
    })),
    commitments,
    trustee_of: trusteeOf,
  });
}

const bodySchema = z.object({
  role: z.enum(["buyer", "sender", "seller", "developer", "company"]),
  displayName: z.string().trim().min(2).max(80),
  companyName: z.string().trim().max(120).optional(),
  registrationNumber: z.string().trim().max(40).optional(),
});

/** Open an account on the proven number or email. One per subject; the role is chosen once. */
export async function POST(request: Request): Promise<NextResponse> {
  const session = currentSender(request);
  if (!session) return NextResponse.json({ error: "Verify your phone number first" }, { status: 401 });
  if (await currentAccount(request)) {
    return NextResponse.json({ error: "This address already has an account" }, { status: 409 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid account" }, { status: 400 });
  }
  const input = parsed.data;
  if (!SELF_SERVICE_ROLES.includes(input.role)) {
    return NextResponse.json({ error: "That role is appointed, not chosen" }, { status: 400 });
  }
  if (input.role === "company" && !input.companyName) {
    return NextResponse.json({ error: "A company account needs the registered company name" }, { status: 400 });
  }
  try {
    const account = await createAccount({ subject: session.subject, ...input });
    return NextResponse.json({
      ok: true,
      account: publicAccount(account),
      message: `Account opened. Your Avalanche address is ${account.address}.`,
    });
  } catch (error) {
    return NextResponse.json({ error: friendlyError(error, "Could not open the account; try again") }, { status: 400 });
  }
}
