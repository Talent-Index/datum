import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { toHex } from "viem";

import {
  escrowAbi,
  escrowAddress,
  platformWallet,
  publicClient,
  revertReason,
  surveyorWallet,
} from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { MILESTONES, PROJECT_ID, ensureProject } from "@/lib/project";

const bodySchema = z.object({ role: z.union([z.literal(1), z.literal(2)]) });

/** Surveyor or platform signs. Two of three releases the funds. */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Role must be 1 (surveyor) or 2 (platform)" },
      { status: 400 },
    );
  }
  const role = parsed.data.role;

  await ensureProject();

  const chain = publicClient();
  const milestoneId = Number(
    await chain.readContract({
      address: escrowAddress(),
      abi: escrowAbi,
      functionName: "nextMilestone",
    }),
  );
  if (milestoneId >= MILESTONES.length) {
    return NextResponse.json({ error: "All milestones complete" }, { status: 400 });
  }

  // Countersign the oracle's accepted evidence for this milestone; a zero
  // hash when the oracle has not ruled matches the reference behaviour.
  const latest = await db()
    .select({ evidenceHash: schema.attestations.evidenceHash })
    .from(schema.attestations)
    .where(
      and(
        eq(schema.attestations.projectId, PROJECT_ID),
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
      address: escrowAddress(),
      abi: escrowAbi,
      functionName: "attest",
      args: [BigInt(milestoneId), role, evidenceHash],
      account,
      chain: client.chain,
    });
    await publicClient().waitForTransactionReceipt({ hash });

    await db().insert(schema.attestations).values({
      projectId: PROJECT_ID,
      milestoneIndex: milestoneId,
      role,
      evidenceHash,
      accepted: true,
      txHash: hash,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: revertReason(error) }, { status: 400 });
  }
}
