import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { currentAccount } from "@/lib/accounts";
import { db, schema } from "@/lib/db";
import { STAGES } from "@/lib/evidence/classifier";
import { LISTING_ROLES, logActivity, payloadHash, postListingOnChain, type Role } from "@/lib/registry";

/**
 * Listings: what sellers, developers and companies advertise.
 *
 * Posting requires a verified identity, and the registry contract enforces
 * that a second time on chain. A listing goes live only after a trustee
 * approves it, and approval deploys the escrow buyers pay into.
 */
const milestoneSchema = z.object({
  description: z.string().trim().min(3).max(120),
  stage: z.enum(STAGES),
  percent: z.number().int().min(1).max(100),
});

const bodySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,40}$/, "id: 3-40 lowercase letters, digits, hyphens"),
  kind: z.enum(["property_sale", "build", "development"]),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2000),
  locationName: z.string().trim().min(2).max(120),
  latitude: z.number().min(-5).max(5),
  longitude: z.number().min(33).max(42),
  priceKes: z.number().int().positive().max(2_000_000_000),
  milestones: z.array(milestoneSchema).min(1).max(12).optional(),
});

/** What each role may list. A seller sells what exists; builders and companies raise for what does not. */
const KIND_BY_ROLE: Record<string, readonly string[]> = {
  seller: ["property_sale"],
  developer: ["build", "development"],
  company: ["development", "property_sale"],
};

const SALE_MILESTONES = [{ description: "Handover and title transfer", stage: "finishing", percent: 100 }];

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const account = await currentAccount(request);
  const reviewer = isOperator(request) || account?.role === "trustee";
  const database = db();
  const query = database
    .select({
      id: schema.listings.id,
      kind: schema.listings.kind,
      title: schema.listings.title,
      description: schema.listings.description,
      location: schema.listings.locationName,
      latitude: schema.listings.latitude,
      longitude: schema.listings.longitude,
      price_kes: schema.listings.priceKes,
      milestones: schema.listings.milestones,
      status: schema.listings.status,
      project_id: schema.listings.projectId,
      trustee_account_id: schema.listings.trusteeAccountId,
      note: schema.listings.reviewNote,
      content_hash: schema.listings.contentHash,
      tx: schema.listings.txHash,
      created_at: schema.listings.createdAt,
      owner: schema.accounts.displayName,
      owner_company: schema.accounts.companyName,
      owner_role: schema.accounts.role,
      owner_address: schema.accounts.address,
      owner_kyc: schema.accounts.kycStatus,
    })
    .from(schema.listings)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.listings.ownerAccountId));

  if (scope === "pending" && reviewer) {
    return NextResponse.json({ listings: await query.where(eq(schema.listings.status, "pending_review")).orderBy(desc(schema.listings.createdAt)) });
  }
  if (scope === "all" && reviewer) {
    return NextResponse.json({ listings: await query.orderBy(desc(schema.listings.createdAt)).limit(200) });
  }
  return NextResponse.json({ listings: await query.where(eq(schema.listings.status, "live")).orderBy(desc(schema.listings.createdAt)) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  if (!LISTING_ROLES.includes(account.role as Role)) {
    return NextResponse.json({ error: "Only sellers, developers and companies can list" }, { status: 403 });
  }
  if (account.kycStatus !== "verified") {
    return NextResponse.json({ error: "Your identity must be verified before you can list" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid listing" }, { status: 400 });
  }
  const input = parsed.data;
  if (!KIND_BY_ROLE[account.role]?.includes(input.kind)) {
    return NextResponse.json({ error: `A ${account.role} cannot post a ${input.kind.replace("_", " ")}` }, { status: 400 });
  }
  const milestones = input.kind === "property_sale" ? SALE_MILESTONES : input.milestones;
  if (!milestones?.length) {
    return NextResponse.json({ error: "A build or development needs its milestone schedule" }, { status: 400 });
  }
  const total = milestones.reduce((s, m) => s + m.percent, 0);
  if (total !== 100) return NextResponse.json({ error: `Milestone percentages sum to ${total}; they must sum to 100` }, { status: 400 });

  const database = db();
  const [exists] = await database.select({ id: schema.listings.id }).from(schema.listings).where(eq(schema.listings.id, input.id));
  if (exists) return NextResponse.json({ error: `Listing '${input.id}' already exists` }, { status: 409 });

  const content = {
    id: input.id,
    kind: input.kind,
    title: input.title,
    description: input.description,
    location: input.locationName,
    latitude: input.latitude,
    longitude: input.longitude,
    priceKes: input.priceKes,
    milestones,
    owner: account.address,
  };
  const contentHash = payloadHash(content);

  let txHash: string;
  try {
    txHash = await postListingOnChain(input.id, account.address as `0x${string}`, contentHash);
  } catch (error) {
    return NextResponse.json(
      { error: `The registry refused the listing: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  await database.insert(schema.listings).values({
    id: input.id,
    ownerAccountId: account.id,
    kind: input.kind,
    title: input.title,
    description: input.description,
    locationName: input.locationName,
    latitude: input.latitude,
    longitude: input.longitude,
    priceKes: input.priceKes,
    milestones,
    contentHash,
    txHash,
  });
  await logActivity({
    accountId: account.id,
    actorAddress: account.address as `0x${string}`,
    kind: "listing.posted",
    payload: { listing: input.id, kind: input.kind, contentHash, txHash },
  });

  return NextResponse.json({
    ok: true,
    id: input.id,
    txHash,
    message: "Listed and recorded on chain. A trustee reviews it before it goes live.",
  });
}
