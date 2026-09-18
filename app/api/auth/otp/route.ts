import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { generateOtp, hashOtp } from "@/lib/auth";
import { normaliseMsisdn } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { normaliseEmail, sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";

/**
 * Send a one-time code to a phone number or an email address. Typing it
 * back proves the handset or the inbox. Buyers use the number they pay
 * from; sellers, developers, companies and senders abroad use email and
 * add a number afterwards.
 */
const bodySchema = z
  .object({
    phone: z.string().trim().regex(/^(?:\+?254|0)7\d{8}$/, "Enter a Safaricom number such as 0712345678").optional(),
    email: z.string().trim().email("Enter a valid email address").optional(),
  })
  .refine((b) => !!b.phone !== !!b.email, { message: "Send either a phone number or an email address" });

const CODE_MINUTES = 5;
const RESEND_SECONDS = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const subject = parsed.data.phone ? normaliseMsisdn(parsed.data.phone) : normaliseEmail(parsed.data.email!);
  const database = db();

  // One live code per subject at a time; a resend inside the window is
  // refused rather than stacking codes, which also throttles message spend.
  const recent = await database
    .select({ createdAt: schema.otpCodes.createdAt })
    .from(schema.otpCodes)
    .where(
      and(
        eq(schema.otpCodes.phone, subject),
        gt(schema.otpCodes.createdAt, new Date(Date.now() - RESEND_SECONDS * 1000)),
      ),
    );
  if (recent.length) {
    return NextResponse.json(
      { error: `A code was sent less than ${RESEND_SECONDS} seconds ago; wait before asking again` },
      { status: 429 },
    );
  }

  const code = generateOtp();
  await database.delete(schema.otpCodes).where(eq(schema.otpCodes.phone, subject));
  await database.insert(schema.otpCodes).values({
    phone: subject,
    codeHash: hashOtp(subject, code),
    expiresAt: new Date(Date.now() + CODE_MINUTES * 60 * 1000),
  });

  const text = `${code} is your Datum code. It expires in ${CODE_MINUTES} minutes.`;
  const sent = parsed.data.phone
    ? await sendSms(subject, text)
    : await sendEmail(subject, "Your Datum sign-in code", text);

  return NextResponse.json({
    ok: true,
    subject,
    delivered: sent.delivered,
    message: sent.delivered
      ? `Code sent to ${subject}.`
      : process.env.OTP_TEST_CODE
        ? `No ${parsed.data.phone ? "SMS" : "email"} provider is configured on this deployment; enter the demo code.`
        : `No ${parsed.data.phone ? "SMS" : "email"} provider is configured; the code was written to the server log.`,
  });
}
