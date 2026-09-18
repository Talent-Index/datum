import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { accountById, canReview, currentAccount } from "@/lib/accounts";
import { platformWallet } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { logActivity, setKycOnChain } from "@/lib/registry";

const bodySchema = z.object({
  id: z.number().int().positive(),
  decision: z.enum(["verify", "reject"]),
  note: z.string().trim().max(500).optional(),
});

/**
 * A trustee's verdict on an identity check. Recorded on chain against the
 * document hash with the reviewer's address, so every verification is
 * attributable to the person who made it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const reviewer = await currentAccount(request);
  const operator = isOperator(request);
  if (!canReview(reviewer, operator)) {
    return NextResponse.json({ error: "Trustee or operator access required" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body must be { id, decision, note? }" }, { status: 400 });
  }
  const { id, decision, note } = parsed.data;
  const database = db();
  const [submission] = await database.select().from(schema.kycSubmissions).where(eq(schema.kycSubmissions.id, id));
  if (!submission) return NextResponse.json({ error: "No such submission" }, { status: 404 });
  if (submission.status !== "pending") {
    return NextResponse.json({ error: `Already ${submission.status}` }, { status: 409 });
  }
  const subject = await accountById(submission.accountId);
  if (!subject) return NextResponse.json({ error: "The account no longer exists" }, { status: 404 });
  if (reviewer && reviewer.id === subject.id) {
    return NextResponse.json({ error: "You cannot verify your own identity" }, { status: 403 });
  }

  const verified = decision === "verify";
  const reviewerAddress = (reviewer?.address ?? platformWallet().account.address) as `0x${string}`;
  let txHash: string;
  try {
    txHash = await setKycOnChain(
      subject.address as `0x${string}`,
      verified,
      `0x${submission.documentSha256}` as `0x${string}`,
      reviewerAddress,
    );
  } catch (error) {
    return NextResponse.json(
      { error: `The verdict could not be recorded on chain: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }

  await database
    .update(schema.kycSubmissions)
    .set({
      status: verified ? "verified" : "rejected",
      reviewerAccountId: reviewer?.id ?? null,
      reviewNote: note?.trim() || null,
      txHash,
      reviewedAt: new Date(),
    })
    .where(eq(schema.kycSubmissions.id, id));
  await database
    .update(schema.accounts)
    .set({ kycStatus: verified ? "verified" : "rejected" })
    .where(eq(schema.accounts.id, subject.id));

  await logActivity({
    accountId: reviewer?.id ?? null,
    actorAddress: reviewerAddress,
    kind: verified ? "kyc.verified" : "kyc.rejected",
    payload: { subject: subject.address, submission: id, documentSha256: submission.documentSha256, txHash },
  });

  return NextResponse.json({
    ok: true,
    txHash,
    message: verified
      ? `${subject.displayName} is verified. They can now list.`
      : `${subject.displayName} was not verified. They can submit again.`,
  });
}
