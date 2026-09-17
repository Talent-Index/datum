import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { generateOtp, hashOtp } from "@/lib/auth";
import { normaliseMsisdn } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { sendSms } from "@/lib/sms";

const bodySchema = z.object({
  phone: z.string().trim().regex(/^(?:\+?254|0)7\d{8}$/, "Enter a Safaricom number such as 0712345678"),
});

const CODE_MINUTES = 5;
const RESEND_SECONDS = 60;

/** Send a one-time code to the number; typing it back proves the handset. */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const phone = normaliseMsisdn(parsed.data.phone);
  const database = db();

  // One live code per number at a time; a resend inside the window is
  // refused rather than stacking codes, which also throttles SMS spend.
  const recent = await database
    .select({ createdAt: schema.otpCodes.createdAt })
    .from(schema.otpCodes)
    .where(
      and(
        eq(schema.otpCodes.phone, phone),
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
  await database.delete(schema.otpCodes).where(eq(schema.otpCodes.phone, phone));
  await database.insert(schema.otpCodes).values({
    phone,
    codeHash: hashOtp(phone, code),
    expiresAt: new Date(Date.now() + CODE_MINUTES * 60 * 1000),
  });

  const sent = await sendSms(phone, `${code} is your Datum code. It expires in ${CODE_MINUTES} minutes.`);

  return NextResponse.json({
    ok: true,
    phone,
    delivered: sent.delivered,
    message: sent.delivered
      ? `Code sent to ${phone}.`
      : `No SMS provider is configured; the code was written to the server log.`,
  });
}
