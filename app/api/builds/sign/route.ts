import { NextResponse } from "next/server";
import { z } from "zod";

import { currentAccount } from "@/lib/accounts";
import { buildById, publicBuild, signAgreement } from "@/lib/builds";

const bodySchema = z.object({ id: z.string().min(3).max(40) });

/** The owner or the builder signs. The second signature deploys the escrow and starts the build. */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Body must be { id }" }, { status: 400 });
  const build = await buildById(parsed.data.id);
  if (!build) return NextResponse.json({ error: "No such build" }, { status: 404 });
  try {
    const result = await signAgreement(build, account);
    return NextResponse.json({
      ok: true,
      activated: result.activated,
      build: publicBuild(result.build),
      message: result.activated
        ? `Both signatures are in. The escrow is deployed, your KES ${build.initialDepositKes.toLocaleString("en-US")} deposit is in it, and building can start.`
        : "Signed and recorded on chain. Waiting for the other party.",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not sign" }, { status: 400 });
  }
}
