import { NextResponse } from "next/server";
import { z } from "zod";

import { generateOtp, hashOtp } from "@/lib/auth";
import { emailTransport, normaliseEmail, sendEmail, signInCodeMail } from "@/lib/email";
import { issueEmailCode, publicOtpResponse } from "@/lib/onboarding/email-code";
import { dbOtpDirectory } from "@/lib/onboarding/db";
import { OTP_CLOSED } from "@/lib/otp-message";

/**
 * Email is the only sign-in. A code is emailed when delivery is configured,
 * and the response never contains the code or whether the address is new.
 */
const bodySchema = z.object({
  email: z.string().trim().optional(),
  phone: z.string().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.phone || !parsed.data.email) {
    return NextResponse.json(
      { error: "Sign in with your email address. Add the M-Pesa number afterwards; it is where prompts are sent, not how you sign in." },
      { status: 400 },
    );
  }
  const emailCheck = z.string().trim().email("Enter a valid email address").safeParse(parsed.data.email);
  if (!emailCheck.success) return NextResponse.json({ error: emailCheck.error.issues[0]?.message }, { status: 400 });
  if (emailTransport() === "closed") {
    return NextResponse.json({ error: OTP_CLOSED }, { status: 503 });
  }
  const email = normaliseEmail(emailCheck.data);
  let issued;
  try {
    issued = await issueEmailCode(dbOtpDirectory(), email, Date.now(), generateOtp, hashOtp);
  } catch (error) {
    console.error(`[otp] could not store a code: ${error instanceof Error ? error.message : "unavailable"}`);
    return NextResponse.json({ error: "Sign-in storage is not ready. Run the latest database migration." }, { status: 503 });
  }
  if (!issued.ok) return NextResponse.json({ error: issued.error }, { status: issued.status });
  try {
    const mail = signInCodeMail(issued.code);
    await sendEmail(email, mail.subject, mail.text, mail.html);
  } catch (error) {
    console.error(`[otp] email send failed: ${error instanceof Error ? error.message : "unavailable"}`);
    await dbOtpDirectory().remove(email).catch(() => undefined);
    return NextResponse.json({ error: "The code could not be sent. Try again in a minute." }, { status: 502 });
  }
  return NextResponse.json(publicOtpResponse());
}
