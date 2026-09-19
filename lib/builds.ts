import { and, eq } from "drizzle-orm";
import type { Address } from "viem";

import { accountById, type Account } from "./accounts";
import { KES_UNITS, WRITE_GAS, escrowAbi, platformWallet, publicClient } from "./chain";
import { stkPush } from "./daraja";
import { db, schema } from "./db";
import { createProject } from "./project";
import { logActivity, payloadHash } from "./registry";

/**
 * A build that starts with the owner, not a listing.
 *
 * The order is deliberate: the deposit comes before the agreement, so the
 * owner has skin in the game and Datum can spend staff time finding a
 * builder; the agreement is signed by both sides before any escrow
 * exists; and the escrow is deployed by the second signature, with the
 * deposit inside it, so building starts against money that is already
 * protected.
 */

export type BuildRequest = typeof schema.buildRequests.$inferSelect;

export interface BuildMilestone {
  description: string;
  stage: string;
  percent: number;
}

export const DEFAULT_MILESTONES: BuildMilestone[] = [
  { description: "Foundation complete", stage: "foundation", percent: 20 },
  { description: "Ground floor slab", stage: "ground_slab", percent: 20 },
  { description: "Walls to roof level", stage: "superstructure", percent: 25 },
  { description: "Roof on", stage: "roofing", percent: 20 },
  { description: "Finishes complete", stage: "finishing", percent: 15 },
];

const MIN_DEPOSIT_KES = 1000;

/** The initialisation deposit: a share of the budget, never less than a floor. */
export function initialDepositFor(budgetKes: number): number {
  const percent = Number.parseInt(process.env.BUILD_INITIAL_DEPOSIT_PERCENT ?? "10", 10);
  const share = Math.round((budgetKes * (Number.isFinite(percent) && percent > 0 ? percent : 10)) / 100);
  return Math.max(MIN_DEPOSIT_KES, share);
}

export async function buildById(id: string): Promise<BuildRequest | null> {
  const [row] = await db().select().from(schema.buildRequests).where(eq(schema.buildRequests.id, id));
  return row ?? null;
}

/** Send the M-Pesa prompt for the initial deposit to the owner's number. */
export async function requestInitialDeposit(build: BuildRequest, owner: Account): Promise<{ checkoutRequestId: string }> {
  if (!owner.phone) throw new Error("Add the M-Pesa number you will pay from first");
  if (build.depositPaidAt) throw new Error("The initial deposit is already paid");
  const database = db();
  const [recent] = await database
    .select({ id: schema.pendingPayments.id })
    .from(schema.pendingPayments)
    .where(
      and(
        eq(schema.pendingPayments.buildRequestId, build.id),
        eq(schema.pendingPayments.status, "pending"),
      ),
    );
  if (recent) throw new Error("A prompt is already waiting on your handset");
  const push = await stkPush(owner.phone, build.initialDepositKes, build.id.toUpperCase().slice(0, 12));
  await database.insert(schema.pendingPayments).values({
    checkoutRequestId: push.CheckoutRequestID,
    merchantRequestId: push.MerchantRequestID,
    purpose: "initial_deposit",
    projectId: null,
    accountId: owner.id,
    buildRequestId: build.id,
    phone: owner.phone,
    amountKes: build.initialDepositKes,
    status: "pending",
  });
  await logActivity({
    accountId: owner.id,
    actorAddress: owner.address as Address,
    kind: "build.deposit_requested",
    payload: { build: build.id, kes: build.initialDepositKes, checkoutRequestId: push.CheckoutRequestID },
  });
  return { checkoutRequestId: push.CheckoutRequestID };
}

/** Called by payment crediting once Safaricom confirms the initial deposit. */
export async function markInitialDepositPaid(buildId: string, receipt: string | null): Promise<void> {
  const database = db();
  const build = await buildById(buildId);
  if (!build) return;
  await database
    .update(schema.buildRequests)
    .set({ depositPaidAt: new Date(), status: build.status === "requested" ? "deposit_paid" : build.status })
    .where(eq(schema.buildRequests.id, buildId));
  const owner = await accountById(build.ownerAccountId);
  if (owner) {
    await logActivity({
      accountId: owner.id,
      actorAddress: owner.address as Address,
      kind: "build.deposit_paid",
      payload: { build: build.id, kes: build.initialDepositKes, receipt },
    });
  }
}

export interface Proposal {
  builderAccountId: number;
  trusteeAccountId: number;
  priceKes: number;
  milestones: BuildMilestone[];
}

/** Staff propose the agreement. The hash is what both sides sign. */
export async function proposeAgreement(build: BuildRequest, proposal: Proposal, by: Address): Promise<BuildRequest> {
  if (!build.depositPaidAt) throw new Error("The initial deposit has not been paid");
  if (["signed", "active", "cancelled"].includes(build.status)) throw new Error(`This build is ${build.status}`);
  const builder = await accountById(proposal.builderAccountId);
  if (!builder || !["developer", "company"].includes(builder.role)) throw new Error("The builder must be a developer or company account");
  if (builder.kycStatus !== "verified") throw new Error("The builder has not been verified by staff");
  const trustee = await accountById(proposal.trusteeAccountId);
  if (!trustee || trustee.role !== "trustee") throw new Error("Assign a trustee");
  const total = proposal.milestones.reduce((s, m) => s + m.percent, 0);
  if (total !== 100) throw new Error(`Milestone percentages sum to ${total}; they must sum to 100`);
  if (proposal.priceKes < build.initialDepositKes) throw new Error("The price cannot be below the deposit already paid");

  const agreement = {
    build: build.id,
    owner: (await accountById(build.ownerAccountId))?.address,
    builder: builder.address,
    trustee: trustee.address,
    priceKes: proposal.priceKes,
    initialDepositKes: build.initialDepositKes,
    milestones: proposal.milestones,
    location: [build.latitude, build.longitude],
  };
  const agreementHash = payloadHash(agreement);
  const [row] = await db()
    .update(schema.buildRequests)
    .set({
      builderAccountId: builder.id,
      trusteeAccountId: trustee.id,
      priceKes: proposal.priceKes,
      milestones: proposal.milestones,
      agreementHash,
      ownerSignedAt: null,
      ownerSignTx: null,
      builderSignedAt: null,
      builderSignTx: null,
      status: "proposed",
    })
    .where(eq(schema.buildRequests.id, build.id))
    .returning();
  await logActivity({
    accountId: null,
    actorAddress: by,
    kind: "agreement.proposed",
    payload: { build: build.id, agreementHash, builder: builder.address, trustee: trustee.address, priceKes: proposal.priceKes },
  });
  return row!;
}

/**
 * One party signs. The signature is an activity on chain from their own
 * address carrying the agreement hash. The second signature deploys the
 * escrow and moves the deposit into it.
 */
export async function signAgreement(build: BuildRequest, signer: Account): Promise<{ build: BuildRequest; activated: boolean }> {
  if (build.status !== "proposed" && build.status !== "signed") throw new Error(`Nothing to sign; this build is ${build.status}`);
  if (!build.agreementHash) throw new Error("No agreement has been proposed yet");
  const isOwner = signer.id === build.ownerAccountId;
  const isBuilder = signer.id === build.builderAccountId;
  if (!isOwner && !isBuilder) throw new Error("Only the owner and the builder sign this agreement");
  if ((isOwner && build.ownerSignedAt) || (isBuilder && build.builderSignedAt)) throw new Error("You have already signed");

  const logged = await logActivity({
    accountId: signer.id,
    actorAddress: signer.address as Address,
    kind: isOwner ? "agreement.signed_by_owner" : "agreement.signed_by_builder",
    payload: { build: build.id, agreementHash: build.agreementHash },
  });
  const now = new Date();
  const [row] = await db()
    .update(schema.buildRequests)
    .set(
      isOwner
        ? { ownerSignedAt: now, ownerSignTx: logged.txHash, status: build.builderSignedAt ? "signed" : "proposed" }
        : { builderSignedAt: now, builderSignTx: logged.txHash, status: build.ownerSignedAt ? "signed" : "proposed" },
    )
    .where(eq(schema.buildRequests.id, build.id))
    .returning();
  const updated = row!;
  if (updated.status !== "signed") return { build: updated, activated: false };
  return { build: await activate(updated), activated: true };
}

/** Both have signed: deploy the escrow, put the deposit in, start building. */
async function activate(build: BuildRequest): Promise<BuildRequest> {
  const owner = await accountById(build.ownerAccountId);
  const builder = build.builderAccountId ? await accountById(build.builderAccountId) : null;
  const trustee = build.trusteeAccountId ? await accountById(build.trusteeAccountId) : null;
  if (!owner || !builder || !trustee) throw new Error("The agreement's parties no longer exist");

  const project = await createProject({
    id: build.id,
    name: build.title,
    developerName: builder.companyName ?? builder.displayName,
    projectRef: null,
    latitude: build.latitude,
    longitude: build.longitude,
    developerAddress: builder.address as Address,
    trusteePhone: trustee.subject,
    ownerAccountId: owner.id,
    trusteeAccountId: trustee.id,
    listingId: null,
    fundingTargetKes: build.priceKes,
    milestones: (build.milestones as BuildMilestone[]) ?? DEFAULT_MILESTONES,
  });

  // The initial deposit was M-Pesa money recorded against the request; now
  // there is an escrow it becomes the owner's first claim in it.
  const { client, account } = platformWallet();
  const depositTx = await client.writeContract({
    address: project.contractAddress,
    abi: escrowAbi,
    functionName: "depositFor",
    args: [owner.address as Address, BigInt(build.initialDepositKes) * KES_UNITS],
    account,
    chain: client.chain,
    gas: WRITE_GAS,
  });
  await publicClient().waitForTransactionReceipt({ hash: depositTx });

  const database = db();
  await database
    .insert(schema.buyers)
    .values({ projectId: project.id, phone: owner.phone ?? owner.subject, walletAddress: owner.address, commitmentKes: build.priceKes })
    .onConflictDoNothing();
  const [row] = await database
    .update(schema.buildRequests)
    .set({ status: "active", projectId: project.id })
    .where(eq(schema.buildRequests.id, build.id))
    .returning();
  await logActivity({
    accountId: owner.id,
    actorAddress: owner.address as Address,
    kind: "build.started",
    payload: { build: build.id, project: project.id, contract: project.contractAddress, initialDepositKes: build.initialDepositKes, depositTx },
  });
  return row!;
}

export function publicBuild(b: BuildRequest, extra: { owner?: Account | null; builder?: Account | null; trustee?: Account | null } = {}) {
  return {
    id: b.id,
    title: b.title,
    description: b.description,
    location: b.locationName,
    latitude: b.latitude,
    longitude: b.longitude,
    budget_kes: b.budgetKes,
    initial_deposit_kes: b.initialDepositKes,
    deposit_paid_at: b.depositPaidAt,
    price_kes: b.priceKes,
    milestones: b.milestones,
    agreement_hash: b.agreementHash,
    owner_signed_at: b.ownerSignedAt,
    owner_sign_tx: b.ownerSignTx,
    builder_signed_at: b.builderSignedAt,
    builder_sign_tx: b.builderSignTx,
    status: b.status,
    project_id: b.projectId,
    note: b.note,
    created_at: b.createdAt,
    owner: extra.owner ? { id: extra.owner.id, name: extra.owner.displayName, address: extra.owner.address, email: extra.owner.email, phone: extra.owner.phone } : null,
    builder: extra.builder ? { id: extra.builder.id, name: extra.builder.companyName ?? extra.builder.displayName, address: extra.builder.address } : null,
    trustee: extra.trustee ? { id: extra.trustee.id, name: extra.trustee.displayName, address: extra.trustee.address } : null,
  };
}
