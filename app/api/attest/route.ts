import { NextResponse } from "next/server";

import { isOperator } from "@/lib/auth";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { toHex } from "viem";

import {
  WRITE_GAS,
  escrowAbi,
  platformWallet,
  publicClient,
  revertReason,
  surveyorWallet,
} from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { isRemittance, missingProjectMessage, resolveProject } from "@/lib/project";
import { logActivity } from "@/lib/registry";

const bodySchema = z.object({ role: z.union([z.literal(1), z.literal(2)]) });

/** Surveyor or platform signs. Two of three releases the funds. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isOperator(request)) {
    return NextResponse.json({ error: "Operator access required" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Role must be 1 (surveyor) or 2 (platform)" },
      { status: 400 },
    );
  }
  const role = parsed.data.role;

  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: await missingProjectMessage(request) }, { status: 400 });
  }
  // On a remittance build attester 1 is the sender, who signs from their own
  // page with their own session; the surveyor key is not on that contract.
  if (role === 1 && isRemittance(project)) {
    return NextResponse.json(
      { error: "This project's second signature belongs to the sender; they approve from their page" },
      { status: 400 },
    );
  }

  const chain = publicClient();
  const milestoneId = Number(
    await chain.readContract({
      address: project.contractAddress,
      abi: escrowAbi,
      functionName: "nextMilestone",
    }),
  );
  if (milestoneId >= project.milestones.length) {
    return NextResponse.json({ error: "All milestones complete" }, { status: 400 });
  }

  // Countersign the oracle's accepted evidence for this milestone; a zero
  // hash when the oracle has not ruled matches the reference behaviour.
  const latest = await db()
    .select({ evidenceHash: schema.attestations.evidenceHash })
    .from(schema.attestations)
    .where(
      and(
        eq(schema.attestations.projectId, project.id),
        eq(schema.attestations.milestoneIndex, milestoneId),
        eq(schema.attestations.accepted, true),
      ),
    )
    .orderBy(desc(schema.attestations.id))
    .limit(1);
  const evidenceHash = (latest[0]?.evidenceHash ?? toHex(new Uint8Array(32))) as `0x${string}`;

  try {
    const { client, account } = role === 1 ? surveyorWallet() : platformWallet();
    const hash = await client.writeContract({
      address: project.contractAddress,
      abi: escrowAbi,
      functionName: "attest",
      args: [BigInt(milestoneId), role, evidenceHash],
      account,
      chain: client.chain,
      gas: WRITE_GAS,
    });
    await publicClient().waitForTransactionReceipt({ hash });

    await db().insert(schema.attestations).values({
      projectId: project.id,
      milestoneIndex: milestoneId,
      role,
      evidenceHash,
      accepted: true,
      txHash: hash,
    });
    await logActivity({
      accountId: null,
      actorAddress: account.address,
      kind: "milestone.countersigned",
      payload: { project: project.id, milestone: milestoneId, role, evidenceHash, attestTx: hash },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: revertReason(error) }, { status: 400 });
  }
}
