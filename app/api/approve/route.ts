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
import { db, schema } from "@/lib/db";
import { isRemittance, resolveProject } from "@/lib/project";

/**
 * The sender's decision on a milestone.
 *
 * On a remittance build the person who sent the money is attester 1, so this
 * is the second of the two signatures a release needs — the builder has the
 * first only when the photographs passed. Declining signs nothing: the money
 * stays where it is and the builder has to submit evidence that holds up.
 */
const bodySchema = z.object({
  decision: z.enum(["approve", "decline"]),
  reason: z.string().max(500).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: "Specify ?project=<id>" }, { status: 400 });
  }
  if (!isRemittance(project) || !project.senderPhone) {
    return NextResponse.json(
      { error: "This project has no sender; a surveyor countersigns it" },
      { status: 400 },
    );
  }

  // The second signature is the sender's alone. Anyone else with a session
  // — another buyer, a curious visitor — is refused before the body is read.
  const session = currentSender(request);
  if (!session) {
    return NextResponse.json({ error: "Verify your phone number first" }, { status: 401 });
  }
  if (session.phone !== project.senderPhone) {
    return NextResponse.json(
      { error: "Only the sender on this project can approve or decline a milestone" },
      { status: 403 },
    );
  }
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
        ? `Sender declined: ${reason.trim()}`
        : "Sender declined this milestone.",
      verdict: null,
      txHash: null,
    });
    return NextResponse.json({
      ok: true,
      released: false,
      message: "Declined. No money has moved and the builder has been recorded as not paid.",
    });
  }

  let txHash: string;
  try {
    const { client, account } = senderWallet(project.senderPhone);
    txHash = await client.writeContract({
      address: project.contractAddress,
      abi: escrowAbi,
      functionName: "attest",
      args: [BigInt(milestoneId), 1, latest.evidenceHash as `0x${string}`],
      account,
      chain: client.chain,
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
    summary: "Sender approved this milestone from the photographs.",
    verdict: null,
    txHash,
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
