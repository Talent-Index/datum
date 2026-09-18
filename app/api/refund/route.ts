import { NextResponse } from "next/server";

import { isOperator } from "@/lib/auth";
import { eq } from "drizzle-orm";

import {
  KES_UNITS,
  escrowAbi,
  kesAbi,
  platformWallet,
  publicClient,
  revertReason,
  WRITE_GAS,
} from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { missingProjectMessage, resolveProject } from "@/lib/project";
import { logActivity } from "@/lib/registry";

/**
 * Every buyer takes their pro rata share of what is left. claimRefund is
 * callable by anyone and pays the buyer's address, so the platform can run
 * the sweep without holding any buyer key.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isOperator(request)) {
    return NextResponse.json({ error: "Operator access required" }, { status: 401 });
  }
  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: await missingProjectMessage(request) }, { status: 400 });
  }

  const chain = publicClient();
  const escrow = { address: project.contractAddress, abi: escrowAbi } as const;
  const buyers = await db()
    .select()
    .from(schema.buyers)
    .where(eq(schema.buyers.projectId, project.id));

  const paid: Array<{ phone: string; refund: number }> = [];
  for (const buyer of buyers) {
    const address = buyer.walletAddress as `0x${string}`;
    const deposited = await chain.readContract({
      ...escrow,
      functionName: "deposited",
      args: [address],
    });
    if (deposited === 0n) continue;
    const refunded = await chain.readContract({
      ...escrow,
      functionName: "refunded",
      args: [address],
    });
    if (refunded) continue;

    const before = await chain.readContract({
      address: project.kesAddress,
      abi: kesAbi,
      functionName: "balanceOf",
      args: [address],
    });
    try {
      const { client, account } = platformWallet();
      const hash = await client.writeContract({
        ...escrow,
        functionName: "claimRefund",
        args: [address],
        account,
        chain: client.chain,
        gas: WRITE_GAS,
      });
      await publicClient().waitForTransactionReceipt({ hash });
    } catch (error) {
      return NextResponse.json({ error: revertReason(error) }, { status: 400 });
    }
    const after = await chain.readContract({
      address: project.kesAddress,
      abi: kesAbi,
      functionName: "balanceOf",
      args: [address],
    });
    paid.push({ phone: buyer.phone, refund: Number((after - before) / KES_UNITS) });
  }

  if (paid.length) {
    await logActivity({
      accountId: null,
      actorAddress: platformWallet().account.address,
      kind: "project.refunded",
      payload: { project: project.id, refunds: paid },
    });
  }
  return NextResponse.json({ ok: true, refunds: paid });
}
