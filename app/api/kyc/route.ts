import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { canReview, currentAccount } from "@/lib/accounts";
import { db, schema } from "@/lib/db";
import { logActivity } from "@/lib/registry";

/**
 * Identity check, submitted by the account holder.
 *
 * The document is hashed and discarded: what is kept is enough to review
 * against and enough to prove later what was reviewed, and nothing that
 * would make this table a store of identity documents. The verdict lands
 * on chain against the hash when a trustee reviews it.
 */
const fieldsSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  idType: z.enum(["national_id", "passport", "company_registration"]),
  idNumber: z.string().trim().min(4).max(40),
});

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  if (account.kycStatus === "verified") {
    return NextResponse.json({ error: "This account is already verified" }, { status: 409 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Send multipart form data" }, { status: 400 });
  const parsed = fieldsSchema.safeParse({
    fullName: form.get("fullName"),
    idType: form.get("idType"),
    idNumber: form.get("idNumber"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid submission" }, { status: 400 });
  }
  const document = form.get("document");
  if (!(document instanceof File) || document.size === 0) {
    return NextResponse.json({ error: "Attach a photo or scan of the document" }, { status: 400 });
  }
  if (document.size > MAX_DOCUMENT_BYTES) {
    return NextResponse.json({ error: "The document must be under 8 MB" }, { status: 400 });
  }
  if (account.role === "company" && parsed.data.idType !== "company_registration") {
    return NextResponse.json({ error: "A company verifies with its certificate of registration" }, { status: 400 });
  }

  const bytes = Buffer.from(await document.arrayBuffer());
  const documentSha256 = createHash("sha256").update(bytes).digest("hex");
  const idNumberHash = createHash("sha256").update(`${account.subject}:${parsed.data.idNumber}`).digest("hex");
  const database = db();

  const [pending] = await database
    .select({ id: schema.kycSubmissions.id })
    .from(schema.kycSubmissions)
    .where(and(eq(schema.kycSubmissions.accountId, account.id), eq(schema.kycSubmissions.status, "pending")));
  if (pending) {
    return NextResponse.json({ error: "A submission is already waiting for review" }, { status: 409 });
  }

  const [row] = await database
    .insert(schema.kycSubmissions)
    .values({
      accountId: account.id,
      fullName: parsed.data.fullName,
      idType: parsed.data.idType,
      idNumberHash,
      idLast4: parsed.data.idNumber.slice(-4),
      documentSha256,
      documentName: document.name.slice(0, 120),
    })
    .returning({ id: schema.kycSubmissions.id });
  await database.update(schema.accounts).set({ kycStatus: "pending" }).where(eq(schema.accounts.id, account.id));

  await logActivity({
    accountId: account.id,
    actorAddress: account.address as `0x${string}`,
    kind: "kyc.submitted",
    payload: { submission: row!.id, idType: parsed.data.idType, documentSha256 },
  });

  return NextResponse.json({
    ok: true,
    id: row!.id,
    message: "Submitted. A trustee reviews it and the verdict is recorded on chain. You will see the result here.",
  });
}

/** What is waiting for review. Trustees and the operator only. */
export async function GET(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!canReview(account, isOperator(request))) {
    return NextResponse.json({ error: "Trustee or operator access required" }, { status: 401 });
  }
  const rows = await db()
    .select({
      id: schema.kycSubmissions.id,
      status: schema.kycSubmissions.status,
      full_name: schema.kycSubmissions.fullName,
      id_type: schema.kycSubmissions.idType,
      id_last4: schema.kycSubmissions.idLast4,
      document: schema.kycSubmissions.documentName,
      document_sha256: schema.kycSubmissions.documentSha256,
      submitted_at: schema.kycSubmissions.createdAt,
      account_id: schema.accounts.id,
      role: schema.accounts.role,
      display_name: schema.accounts.displayName,
      company_name: schema.accounts.companyName,
      phone: schema.accounts.phone,
      email: schema.accounts.email,
      address: schema.accounts.address,
    })
    .from(schema.kycSubmissions)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.kycSubmissions.accountId))
    .where(eq(schema.kycSubmissions.status, "pending"))
    .orderBy(desc(schema.kycSubmissions.id));
  return NextResponse.json({ submissions: rows });
}
