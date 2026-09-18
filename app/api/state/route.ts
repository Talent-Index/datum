import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { toHex } from "viem";

import { KES_UNITS, escrowAbi, kesAbi, publicClient } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { isRemittance, resolveProject, roleNames } from "@/lib/project";

/** What a buyer, the platform, and a judge all look at: the live project. */
export async function GET(request: Request): Promise<NextResponse> {
  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json(
      { error: "Specify ?project=<id>; more than one project exists" },
      { status: 400 },
    );
  }
  const ROLE_NAMES = roleNames(project);

  const chain = publicClient();
  const escrow = { address: project.contractAddress, abi: escrowAbi } as const;

  const [totalDeposited, totalReleased, held, nextMilestone, statusCode, developerBalance] =
    await Promise.all([
      chain.readContract({ ...escrow, functionName: "totalDeposited" }),
      chain.readContract({ ...escrow, functionName: "totalReleased" }),
      chain.readContract({ ...escrow, functionName: "heldBalance" }),
      chain.readContract({ ...escrow, functionName: "nextMilestone" }),
      chain.readContract({ ...escrow, functionName: "status" }),
      chain.readContract({
        address: project.kesAddress,
        abi: kesAbi,
        functionName: "balanceOf",
        args: [project.developerAddress],
      }),
    ]);
  const status = (["Active", "Stalled", "Completed"] as const)[Number(statusCode)] ?? "Active";
  const next = Number(nextMilestone);

  const zeroHash = toHex(new Uint8Array(32));
  const milestones = await Promise.all(
    project.milestones.map(async (definition, id) => {
      const [description, percent, cumulative, evidenceHash, approvals, released] =
        await chain.readContract({ ...escrow, functionName: "milestones", args: [BigInt(id)] });
      const signers: string[] = [];
      for (const role of [0, 1, 2]) {
        const attested = await chain.readContract({
          ...escrow,
          functionName: "hasAttested",
          args: [BigInt(id), role],
        });
        if (attested) signers.push(ROLE_NAMES[role]!);
      }
      return {
        id,
        description,
        stage: definition.stage,
        percent,
        cumulative,
        evidence_hash: evidenceHash === zeroHash ? null : evidenceHash,
        approvals,
        released,
        signers,
        current: id === next && status === "Active",
      };
    }),
  );

  const buyerRows = await db()
    .select()
    .from(schema.buyers)
    .where(eq(schema.buyers.projectId, project.id));
  const buyers = (
    await Promise.all(
      buyerRows.map(async (buyer) => {
        const [contributed, released, stillHeld] = await chain.readContract({
          ...escrow,
          functionName: "buyerPosition",
          args: [buyer.walletAddress as `0x${string}`],
        });
        // A buyer who has registered but not yet paid still belongs on the
        // ledger: their commitment is what the developer is counting on.
        if (contributed === 0n && !buyer.commitmentKes) return null;
        const refunded = await chain.readContract({
          ...escrow,
          functionName: "refunded",
          args: [buyer.walletAddress as `0x${string}`],
        });
        return {
          phone: buyer.phone,
          address: buyer.walletAddress,
          contributed: Number(contributed / KES_UNITS),
          released: Number(released / KES_UNITS),
          still_held: Number(stillHeld / KES_UNITS),
          commitment: buyer.commitmentKes ?? null,
          refunded,
        };
      }),
    )
  ).filter((b) => b !== null);

  const lastOracle = await db()
    .select({ verdict: schema.attestations.verdict })
    .from(schema.attestations)
    .where(and(eq(schema.attestations.projectId, project.id), eq(schema.attestations.role, 0)))
    .orderBy(desc(schema.attestations.id))
    .limit(1);
  const lastCorroboration = await db()
    .select({ result: schema.corroborations.result })
    .from(schema.corroborations)
    .where(eq(schema.corroborations.projectId, project.id))
    .orderBy(desc(schema.corroborations.id))
    .limit(1);

  return NextResponse.json({
    project: project.id,
    trustee_account_id: project.trusteeAccountId,
    site: project.name,
    status,
    total_deposited: Number(totalDeposited / KES_UNITS),
    total_released: Number(totalReleased / KES_UNITS),
    held: Number(held / KES_UNITS),
    developer_received: Number(developerBalance / KES_UNITS),
    next_milestone: next,
    milestones,
    buyers,
    last_verdict: lastOracle[0]?.verdict ?? null,
    corroboration: lastCorroboration[0]?.result ?? null,
    developer_name: project.developerName,
    funding_target: project.fundingTargetKes ?? 0,
    is_remittance: isRemittance(project),
    sender_phone: project.senderPhone,
    // The sender is asked to decide only once the pipeline has accepted the
    // photographs and their own signature is still outstanding.
    awaiting_sender:
      isRemittance(project) &&
      status === "Active" &&
      (lastOracle[0]?.verdict as { accepted?: boolean } | null)?.accepted === true &&
      milestones[next]?.approvals === 1 &&
      !milestones[next]?.signers.includes("Sender"),
    contract: project.contractAddress,
  });
}
