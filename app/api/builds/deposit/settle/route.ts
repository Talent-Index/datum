import { NextResponse } from "next/server";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { buildById, markInitialDepositPaid } from "@/lib/builds";

const bodySchema = z.object({ id: z.string().min(3).max(40), reason: z.string().trim().min(3).max(300) });

/** Staff record an initial deposit settled outside M-Pesa, with a reason that goes on chain. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isOperator(request)) return NextResponse.json({ error: "Operator access required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Body must be { id, reason }" }, { status: 400 });
  const build = await buildById(parsed.data.id);
  if (!build) return NextResponse.json({ error: "No such build" }, { status: 404 });
  if (build.depositPaidAt) return NextResponse.json({ error: "The deposit is already recorded" }, { status: 409 });
  await markInitialDepositPaid(build.id, `settled by staff: ${parsed.data.reason}`);
  return NextResponse.json({ ok: true, message: `Initial deposit on ${build.title} recorded as settled.` });
}
