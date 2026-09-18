import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { hashOtp, issueSenderToken, setSenderCookie } from "@/lib/auth";
import { normaliseMsisdn } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { normaliseEmail } from "@/lib/email";

const bodySchema = z
  .object({
    phone: z.string().trim().min(9).optional(),
    email: z.string().trim().email().optional(),
    code: z.string().trim().regex(/^\d{6}$/, "The code is six digits"),
  })
  .refine((b) => !!b.phone !== !!b.email, { message: "Send either a phone number or an email address" });

const MAX_ATTEMPTS = 5;

/** Check the code and, if it holds, start a session bound to the subject. */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const subject = parsed.data.phone ? normaliseMsisdn(parsed.data.phone) : normaliseEmail(parsed.data.email!);
  const database = db();

  const [row] = await database.select().from(schema.otpCodes).where(eq(schema.otpCodes.phone, subject));

  if (!row || row.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "No live code for this address; request a new one" }, { status: 400 });
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await database.delete(schema.otpCodes).where(eq(schema.otpCodes.id, row.id));
    return NextResponse.json({ error: "Too many wrong attempts; request a new code" }, { status: 429 });
  }
  if (row.codeHash !== hashOtp(subject, parsed.data.code)) {
    await database
      .update(schema.otpCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(schema.otpCodes.id, row.id));
    return NextResponse.json(
      { error: `Wrong code; ${MAX_ATTEMPTS - row.attempts - 1} attempt(s) left` },
      { status: 400 },
    );
  }

  await database.delete(schema.otpCodes).where(eq(schema.otpCodes.id, row.id));
  const response = NextResponse.json({ ok: true, subject });
  setSenderCookie(response, issueSenderToken(parsed.data.phone ? { phone: subject } : { email: subject }));
  return response;
}
