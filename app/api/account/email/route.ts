import { NextResponse } from "next/server";
import { z } from "zod";

import { accountByEmail, currentAccount } from "@/lib/accounts";
import { generateOtp, hashOtp } from "@/lib/auth";
import { confirmCodeMail, emailTransport, normaliseEmail, sendEmail } from "@/lib/email";
import { dbOtpDirectory } from "@/lib/onboarding/db";
import { issueEmailCode, publicOtpResponse } from "@/lib/onboarding/email-code";
import { OTP_CLOSED } from "@/lib/otp-message";

const bodySchema = z.object({ email: z.string().trim().email("Enter a valid email address") });

/**
 * A legacy phone account adds an email. The code proves the inbox. It does
 * not attach the address when another account already has it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  if (emailTransport() === "closed") return NextResponse.json({ error: OTP_CLOSED }, { status: 503 });
  const email = normaliseEmail(parsed.data.email);
  const clash = await accountByEmail(email);
  if (clash && clash.id !== account.id) {
    return NextResponse.json({ error: "That email already belongs to another account; sign in with it instead" }, { status: 409 });
  }
  let issued;
  try {
    issued = await issueEmailCode(dbOtpDirectory(), email, Date.now(), generateOtp, hashOtp);
  } catch (error) {
    console.error(`[email] could not store a code: ${error instanceof Error ? error.message : "unavailable"}`);
    return NextResponse.json({ error: "Email confirmation is not ready. Run the latest database migration." }, { status: 503 });
  }
  if (!issued.ok) return NextResponse.json({ error: issued.error }, { status: issued.status });
  try {
    const mail = confirmCodeMail(issued.code);
    await sendEmail(email, mail.subject, mail.text, mail.html);
  } catch (error) {
    console.error(`[email] send failed: ${error instanceof Error ? error.message : "unavailable"}`);
    await dbOtpDirectory().remove(email).catch(() => undefined);
    return NextResponse.json({ error: "The code could not be sent. Try again in a minute." }, { status: 502 });
  }
  return NextResponse.json(publicOtpResponse());
}
