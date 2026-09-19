import { NextResponse } from "next/server";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { canReview, currentAccount } from "@/lib/accounts";
import { DEFAULT_MILESTONES, buildById, proposeAgreement, publicBuild } from "@/lib/builds";
import { platformWallet } from "@/lib/chain";
import { STAGES } from "@/lib/evidence/classifier";

const bodySchema = z.object({
  id: z.string().min(3).max(40),
  builderAccountId: z.number().int().positive(),
  trusteeAccountId: z.number().int().positive().optional(),
  priceKes: z.number().int().positive(),
  milestones: z
    .array(z.object({ description: z.string().trim().min(3).max(120), stage: z.enum(STAGES), percent: z.number().int().min(1).max(100) }))
    .min(1)
    .max(12)
    .optional(),
});

/** Staff propose the agreement: builder, trustee, price, milestones. Both sides then sign. */
export async function POST(request: Request): Promise<NextResponse> {
  const reviewer = await currentAccount(request);
  const operator = isOperator(request);
  if (!canReview(reviewer, operator)) return NextResponse.json({ error: "Trustee or operator access required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid proposal" }, { status: 400 });
  const build = await buildById(parsed.data.id);
  if (!build) return NextResponse.json({ error: "No such build" }, { status: 404 });
  const trusteeAccountId = parsed.data.trusteeAccountId ?? (reviewer?.role === "trustee" ? reviewer.id : undefined);
  if (!trusteeAccountId) return NextResponse.json({ error: "Assign a trustee" }, { status: 400 });
  try {
    const updated = await proposeAgreement(
      build,
      { builderAccountId: parsed.data.builderAccountId, trusteeAccountId, priceKes: parsed.data.priceKes, milestones: parsed.data.milestones ?? DEFAULT_MILESTONES },
      (reviewer?.address ?? platformWallet().account.address) as `0x${string}`,
    );
    return NextResponse.json({ ok: true, build: publicBuild(updated), message: "Agreement proposed. The owner and the builder each sign it from their account." });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not propose" }, { status: 400 });
  }
}
