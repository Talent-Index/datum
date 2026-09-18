import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { accountById, canReview, currentAccount } from "@/lib/accounts";
import { platformWallet } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { createProject } from "@/lib/project";
import { logActivity, postListingOnChain, setKycOnChain, setListingLiveOnChain } from "@/lib/registry";

const bodySchema = z.object({
  id: z.string().min(3).max(40),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional(),
  /** Which trustee holds the second signature. Defaults to the reviewing trustee. */
  trusteeAccountId: z.number().int().positive().optional(),
});

interface Milestone {
  description: string;
  stage: string;
  percent: number;
}

/**
 * Approving a listing does the whole thing. Staff have reached out and
 * verified the owner, so the verdict is recorded on chain if it was not
 * already; the listing is posted to the registry, which checks that
 * verdict; the escrow is deployed with the listing's milestones, the
 * owner's address as payee and the assigned trustee as attester 1; the
 * listing is marked live; and buyers can commit from that moment.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const reviewer = await currentAccount(request);
  const operator = isOperator(request);
  if (!canReview(reviewer, operator)) {
    return NextResponse.json({ error: "Trustee or operator access required" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be { id, decision, note?, trusteeAccountId? }" }, { status: 400 });
  }
  const { id, decision, note } = parsed.data;
  const database = db();
  const [listing] = await database.select().from(schema.listings).where(eq(schema.listings.id, id));
  if (!listing) return NextResponse.json({ error: "No such listing" }, { status: 404 });
  if (listing.status !== "pending_review") {
    return NextResponse.json({ error: `Listing is ${listing.status.replace("_", " ")}` }, { status: 409 });
  }
  const owner = await accountById(listing.ownerAccountId);
  if (!owner) return NextResponse.json({ error: "The listing's owner no longer exists" }, { status: 404 });
  if (reviewer && reviewer.id === owner.id) {
    return NextResponse.json({ error: "You cannot approve your own listing" }, { status: 403 });
  }
  const reviewerAddress = (reviewer?.address ?? platformWallet().account.address) as `0x${string}`;

  if (decision === "reject") {
    await database
      .update(schema.listings)
      .set({ status: "rejected", reviewNote: note?.trim() || null })
      .where(eq(schema.listings.id, id));
    await logActivity({
      accountId: reviewer?.id ?? null,
      actorAddress: reviewerAddress,
      kind: "listing.rejected",
      payload: { listing: id, owner: owner.address, note: note?.trim() || null },
    });
    return NextResponse.json({ ok: true, message: "Rejected. The owner can post a revised listing." });
  }

  const trusteeId = parsed.data.trusteeAccountId ?? (reviewer?.role === "trustee" ? reviewer.id : null);
  const trustee = trusteeId ? await accountById(trusteeId) : null;
  if (!trustee || trustee.role !== "trustee") {
    return NextResponse.json({ error: "Assign a trustee to hold the second signature" }, { status: 400 });
  }
  if (owner.feeStatus !== "paid") {
    return NextResponse.json({ error: "The owner has not paid the platform fee" }, { status: 409 });
  }

  // Approval is the staff's word that they verified this person. Record it
  // against the listing's content hash, then post the listing, which the
  // registry refuses unless that verdict is there.
  let kycTx: string | null = null;
  let postTx: string | null = null;
  try {
    if (owner.kycStatus !== "verified") {
      kycTx = await setKycOnChain(owner.address as `0x${string}`, true, listing.contentHash as `0x${string}`, reviewerAddress);
      await database.update(schema.accounts).set({ kycStatus: "verified" }).where(eq(schema.accounts.id, owner.id));
    }
    postTx = await postListingOnChain(listing.id, owner.address as `0x${string}`, listing.contentHash as `0x${string}`);
  } catch (error) {
    return NextResponse.json(
      { error: `The registry refused the listing: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  const milestones = listing.milestones as Milestone[];
  let projectId: string;
  try {
    const project = await createProject({
      id: listing.id,
      name: listing.title,
      developerName: owner.companyName ?? owner.displayName,
      projectRef: null,
      latitude: listing.latitude,
      longitude: listing.longitude,
      developerAddress: owner.address as `0x${string}`,
      trusteePhone: trustee.phone,
      ownerAccountId: owner.id,
      trusteeAccountId: trustee.id,
      listingId: listing.id,
      fundingTargetKes: listing.priceKes,
      milestones,
    });
    projectId = project.id;
  } catch (error) {
    return NextResponse.json(
      { error: `Escrow deployment failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  let liveTx: string | null = null;
  try {
    liveTx = await setListingLiveOnChain(id, true);
  } catch {
    // The escrow exists and buyers can pay; the flag is retried by replay.
  }

  await database
    .update(schema.listings)
    .set({ status: "live", projectId, trusteeAccountId: trustee.id, reviewNote: note?.trim() || null, txHash: postTx })
    .where(eq(schema.listings.id, id));
  await logActivity({
    accountId: reviewer?.id ?? null,
    actorAddress: reviewerAddress,
    kind: "listing.approved",
    payload: { listing: id, owner: owner.address, trustee: trustee.address, project: projectId, kycTx, postTx, liveTx },
  });

  return NextResponse.json({
    ok: true,
    project: projectId,
    message: `Live. Escrow deployed for ${listing.title}; ${trustee.displayName} holds the second signature.`,
  });
}
