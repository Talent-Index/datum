import { NextResponse } from "next/server";
import { z } from "zod";

import { currentAccount } from "@/lib/accounts";
import { buildById, requestInitialDeposit } from "@/lib/builds";

const bodySchema = z.object({ id: z.string().min(3).max(40) });

/** Send the initial-deposit prompt again. Owner only. */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Body must be { id }" }, { status: 400 });
  const build = await buildById(parsed.data.id);
  if (!build || build.ownerAccountId !== account.id) return NextResponse.json({ error: "No such build of yours" }, { status: 404 });
  try {
    const push = await requestInitialDeposit(build, account);
    return NextResponse.json({ ok: true, checkoutRequestId: push.checkoutRequestId, message: `Prompt sent to ${account.phone} for KES ${build.initialDepositKes.toLocaleString("en-US")}.` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not send the prompt" }, { status: 400 });
  }
}
