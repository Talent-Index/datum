import { NextResponse } from "next/server";

import {
  escrowAbi,
  escrowAddress,
  platformWallet,
  publicClient,
  revertReason,
} from "@/lib/chain";

/**
 * The platform declaring a stall is one path; after the timeout any buyer
 * can reach the same function directly on chain without this API — that
 * escape hatch deliberately does not depend on the platform being alive.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const { client, account } = platformWallet();
    const hash = await client.writeContract({
      address: escrowAddress(),
      abi: escrowAbi,
      functionName: "declareStalled",
      account,
      chain: client.chain,
    });
    await publicClient().waitForTransactionReceipt({ hash });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: revertReason(error) }, { status: 400 });
  }
}
