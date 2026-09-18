import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { currentAccount, feeRequired } from "@/lib/accounts";
import { db, schema } from "@/lib/db";
import { STAGES } from "@/lib/evidence/classifier";
import { LISTING_ROLES, logActivity, payloadHash, type Role } from "@/lib/registry";

/**
 * Listings: what sellers, developers and companies advertise.
 *
 * Posting needs the platform fee paid and at least one photograph. The
 * listing then waits for Datum staff, who reach out to the owner, verify
 * them, and approve; approval records the identity verdict and the listing
 * in the registry, deploys the escrow, and puts it live.
 */
const milestoneSchema = z.object({
  description: z.string().trim().min(3).max(120),
  stage: z.enum(STAGES),
  percent: z.number().int().min(1).max(100),
});

const fieldsSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,40}$/, "id: 3-40 lowercase letters, digits, hyphens"),
  kind: z.enum(["property_sale", "build", "development"]),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2000),
  locationName: z.string().trim().min(2).max(120),
  latitude: z.coerce.number().min(-5).max(5),
  longitude: z.coerce.number().min(33).max(42),
  priceKes: z.coerce.number().int().positive().max(2_000_000_000),
  milestones: z.array(milestoneSchema).min(1).max(12).optional(),
});

/** What each role may list. A seller sells what exists; builders and companies raise for what does not. */
const KIND_BY_ROLE: Record<string, readonly string[]> = {
  seller: ["property_sale"],
  developer: ["build", "development"],
  company: ["development", "property_sale"],
};

const SALE_MILESTONES = [{ description: "Handover and title transfer", stage: "finishing", percent: 100 }];
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const account = await currentAccount(request);
  const reviewer = isOperator(request) || account?.role === "trustee";
  const database = db();
  const imageCount = sql<number>`(select count(*)::int from listing_images li where li.listing_id = ${schema.listings.id})`;
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
      images: imageCount,
      owner: schema.accounts.displayName,
      owner_company: schema.accounts.companyName,
      owner_role: schema.accounts.role,
      owner_address: schema.accounts.address,
      owner_kyc: schema.accounts.kycStatus,
      owner_fee: schema.accounts.feeStatus,
      owner_email: reviewer ? schema.accounts.email : sql<null>`null`,
      owner_phone: reviewer ? schema.accounts.phone : sql<null>`null`,
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
  if (feeRequired(account)) {
    return NextResponse.json({ error: "Pay the platform fee before posting" }, { status: 402 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Send multipart form data with the listing fields and images" }, { status: 400 });
  let milestonesRaw: unknown = undefined;
  const milestonesField = form.get("milestones");
  if (typeof milestonesField === "string" && milestonesField.trim()) {
    try {
      milestonesRaw = JSON.parse(milestonesField);
    } catch {
      return NextResponse.json({ error: "milestones must be JSON" }, { status: 400 });
    }
  }
  const parsed = fieldsSchema.safeParse({
    id: form.get("id"),
    kind: form.get("kind"),
    title: form.get("title"),
    description: form.get("description"),
    locationName: form.get("locationName"),
    latitude: form.get("latitude"),
    longitude: form.get("longitude"),
    priceKes: form.get("priceKes"),
    milestones: milestonesRaw,
  });
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

  const files = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: "Attach at least one photograph of what you are listing" }, { status: 400 });
  if (files.length > MAX_IMAGES) return NextResponse.json({ error: `At most ${MAX_IMAGES} photographs` }, { status: 400 });
  if (files.some((f) => f.size > MAX_IMAGE_BYTES)) return NextResponse.json({ error: "Each photograph must be under 12 MB" }, { status: 400 });

  const database = db();
  const [exists] = await database.select({ id: schema.listings.id }).from(schema.listings).where(eq(schema.listings.id, input.id));
  if (exists) return NextResponse.json({ error: `Listing '${input.id}' already exists` }, { status: 409 });

  // Downscaled once so the row stays small and the page stays quick; the
  // original's hash is what goes into the content hash.
  const images: Array<{ sha256: string; data: string }> = [];
  for (const file of files) {
    const original = Buffer.from(await file.arrayBuffer());
    let resized: Buffer;
    try {
      resized = await sharp(original).rotate().resize(1400, 1400, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    } catch {
      return NextResponse.json({ error: `${file.name} is not an image we can read` }, { status: 400 });
    }
    images.push({ sha256: createHash("sha256").update(original).digest("hex"), data: resized.toString("base64") });
  }

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
    images: images.map((i) => i.sha256),
    owner: account.address,
  };
  const contentHash = payloadHash(content);

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
  });
  await database.insert(schema.listingImages).values(
    images.map((img, i) => ({ listingId: input.id, position: i, sha256: img.sha256, contentType: "image/jpeg", dataBase64: img.data })),
  );
  await logActivity({
    accountId: account.id,
    actorAddress: account.address as `0x${string}`,
    kind: "listing.posted",
    payload: { listing: input.id, kind: input.kind, contentHash, images: images.map((i) => i.sha256) },
  });

  return NextResponse.json({
    ok: true,
    id: input.id,
    message: "Posted. Datum staff will reach out to you to verify, and the listing goes live once they approve.",
  });
}
