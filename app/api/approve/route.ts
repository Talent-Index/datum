import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  WRITE_GAS,
  escrowAbi,
  escrowAddress,
  publicClient,
  revertReason,
  senderWallet,
} from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { IS_REMITTANCE, PROJECT_ID, SENDER_PHONE, ensureProject } from "@/lib/project";

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
  if (!IS_REMITTANCE || !SENDER_PHONE) {
    return NextResponse.json(
      { error: "This project has no sender; a surveyor countersigns it. Set SENDER_PHONE." },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be { decision, reason? }" }, { status: 400 });
  }
  const { decision, reason } = parsed.data;

  await ensureProject();
  const chain = publicClient();
  const milestoneId = Number(
    await chain.readContract({
      address: escrowAddress(),
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
    .where(eq(schema.attestations.role, 0))
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
      projectId: PROJECT_ID,
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
    const { client, account } = senderWallet(SENDER_PHONE);
    txHash = await client.writeContract({
      address: escrowAddress(),
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
    projectId: PROJECT_ID,
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
