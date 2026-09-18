import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { accountByEmail, currentAccount } from "@/lib/accounts";
import { generateOtp, hashOtp } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { normaliseEmail, sendEmail } from "@/lib/email";

const bodySchema = z.object({ email: z.string().trim().email("Enter a valid email address") });
const CODE_MINUTES = 5;
const RESEND_SECONDS = 60;

/**
 * A phone account adds an email: a code goes to it and the address is
 * attached when the code comes back. The one-time-code table is keyed on
 * the email itself, so the verify step is the same check as sign-in.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const email = normaliseEmail(parsed.data.email);
  const clash = await accountByEmail(email);
  if (clash && clash.id !== account.id) {
    return NextResponse.json({ error: "That email already belongs to another account; sign in with it instead" }, { status: 409 });
  }
  const database = db();
  const recent = await database
    .select({ id: schema.otpCodes.id })
    .from(schema.otpCodes)
    .where(and(eq(schema.otpCodes.phone, email), gt(schema.otpCodes.createdAt, new Date(Date.now() - RESEND_SECONDS * 1000))));
  if (recent.length) {
    return NextResponse.json({ error: `A code was sent less than ${RESEND_SECONDS} seconds ago; wait before asking again` }, { status: 429 });
  }
  const code = generateOtp();
  await database.delete(schema.otpCodes).where(eq(schema.otpCodes.phone, email));
  await database.insert(schema.otpCodes).values({ phone: email, codeHash: hashOtp(email, code), expiresAt: new Date(Date.now() + CODE_MINUTES * 60 * 1000) });
  const sent = await sendEmail(email, "Confirm your email for Datum", `${code} confirms this email on your Datum account. It expires in ${CODE_MINUTES} minutes.`);
  return NextResponse.json({
    ok: true,
    email,
    delivered: sent.delivered,
    message: sent.delivered ? `Code sent to ${email}.` : "No email provider is configured; use the demo code or check the server log.",
  });
}
