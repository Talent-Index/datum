import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  WRITE_GAS,
  escrowAbi,
  publicClient,
  revertReason,
  senderWallet,
} from "@/lib/chain";
import { currentSender } from "@/lib/auth";
import { currentAccount } from "@/lib/accounts";
import { db, schema } from "@/lib/db";
import { missingProjectMessage, resolveProject } from "@/lib/project";
import { logActivity } from "@/lib/registry";

/**
 * The second signature on a milestone, from whoever holds it.
 *
 * On a remittance build that is the person who sent the money; on a listed
 * project it is the trustee assigned at approval. Either way attester 1 is
 * their managed wallet, the builder has the first signature only when the
 * photographs passed, and declining signs nothing: the money stays where
 * it is and the builder has to submit evidence that holds up.
 */
const bodySchema = z.object({
  decision: z.enum(["approve", "decline"]),
  reason: z.string().max(500).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: await missingProjectMessage(request) }, { status: 400 });
  }
  if (!project.senderPhone && !project.trusteeAccountId) {
    return NextResponse.json(
      { error: "This project has no sender or trustee; a surveyor countersigns it" },
      { status: 400 },
    );
  }

  // The second signature belongs to one person. Anyone else with a session,
  // another buyer or a curious visitor, is refused before the body is read.
  const session = currentSender(request);
  if (!session) {
    return NextResponse.json({ error: "Verify your phone number first" }, { status: 401 });
  }
  const account = await currentAccount(request);
  const isSender = project.senderPhone !== null && (account?.subject ?? session.subject) === project.senderPhone;
  const isTrustee = account !== null && account.id === project.trusteeAccountId;
  if (!isSender && !isTrustee) {
    return NextResponse.json(
      { error: "Only the sender or the assigned trustee on this project can approve or decline a milestone" },
      { status: 403 },
    );
  }
  const signerLabel = isSender ? "Sender" : "Trustee";
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be { decision, reason? }" }, { status: 400 });
  }
  const { decision, reason } = parsed.data;

  const chain = publicClient();
  const milestoneId = Number(
    await chain.readContract({
      address: project.contractAddress,
      abi: escrowAbi,
      functionName: "nextMilestone",
    }),
  );

  // The sender approves what the pipeline already vouched for. Approving a
  // milestone with no accepted evidence would be signing for a photograph
  // nobody has seen.
  const [latest] = await db()
    .select({
      milestoneIndex: schema.attestations.milestoneIndex,
      accepted: schema.attestations.accepted,
      evidenceHash: schema.attestations.evidenceHash,
    })
    .from(schema.attestations)
    .where(and(eq(schema.attestations.projectId, project.id), eq(schema.attestations.role, 0)))
    .orderBy(desc(schema.attestations.id))
    .limit(1);

  if (!latest?.accepted || latest.milestoneIndex !== milestoneId) {
    return NextResponse.json(
      {
        error:
          "No accepted evidence for the current milestone. The builder submits photographs " +
          "first; you approve what they show.",
      },
      { status: 400 },
    );
  }

  if (decision === "decline") {
    await db().insert(schema.attestations).values({
      projectId: project.id,
      milestoneIndex: milestoneId,
      role: 1,
      evidenceHash: latest.evidenceHash,
      accepted: false,
      summary: reason?.trim()
        ? `${signerLabel} declined: ${reason.trim()}`
        : `${signerLabel} declined this milestone.`,
      verdict: null,
      txHash: null,
    });
    await logActivity({
      accountId: account?.id ?? null,
      actorAddress: senderWallet(account?.subject ?? session.subject).account.address,
      kind: "milestone.declined",
      payload: { project: project.id, milestone: milestoneId, reason: reason?.trim() || null },
    });
    return NextResponse.json({
      ok: true,
      released: false,
      message: "Declined. No money has moved and the builder has been recorded as not paid.",
    });
  }

  let txHash: string;
  try {
    const signer = senderWallet(account?.subject ?? session.subject);
    txHash = await signer.client.writeContract({
      address: project.contractAddress,
      abi: escrowAbi,
      functionName: "attest",
      args: [BigInt(milestoneId), 1, latest.evidenceHash as `0x${string}`],
      account: signer.account,
      chain: signer.client.chain,
      gas: WRITE_GAS,
    });
    await chain.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (error) {
    return NextResponse.json(
      { error: `Approval could not be recorded: ${revertReason(error)}` },
      { status: 502 },
    );
  }

  await db().insert(schema.attestations).values({
    projectId: project.id,
    milestoneIndex: milestoneId,
    role: 1,
    evidenceHash: latest.evidenceHash,
    accepted: true,
    summary: `${signerLabel} approved this milestone from the photographs.`,
    verdict: null,
    txHash,
  });
  await logActivity({
    accountId: account?.id ?? null,
    actorAddress: senderWallet(account?.subject ?? session.subject).account.address,
    kind: "milestone.approved",
    payload: { project: project.id, milestone: milestoneId, evidenceHash: latest.evidenceHash, txHash },
  });

  return NextResponse.json({
    ok: true,
    released: true,
    txHash,
    message:
      "Approved. That is the second of two signatures, so this milestone's share has been " +
      "released to the builder. The rest of your money stays in escrow.",
  });
}
