import { NextResponse } from "next/server";

import { isOperator } from "@/lib/auth";

import {
  WRITE_GAS,
  escrowAbi,
  platformWallet,
  publicClient,
  revertReason,
} from "@/lib/chain";
import { missingProjectMessage, resolveProject } from "@/lib/project";
import { logActivity } from "@/lib/registry";

/**
 * The platform declaring a stall is one path; after the timeout any buyer
 * can reach the same function directly on chain without this API — that
 * escape hatch deliberately does not depend on the platform being alive.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isOperator(request)) {
    return NextResponse.json({ error: "Operator access required" }, { status: 401 });
  }
  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: await missingProjectMessage(request) }, { status: 400 });
  }
  try {
    const { client, account } = platformWallet();
    const hash = await client.writeContract({
      address: project.contractAddress,
      abi: escrowAbi,
      functionName: "declareStalled",
      account,
      chain: client.chain,
      gas: WRITE_GAS,
    });
    await publicClient().waitForTransactionReceipt({ hash });
    await logActivity({
      accountId: null,
      actorAddress: account.address,
      kind: "project.stalled",
      payload: { project: project.id, tx: hash },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: revertReason(error) }, { status: 400 });
  }
}
