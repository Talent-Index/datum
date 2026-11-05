import { NextResponse } from "next/server";
import { z } from "zod";

import { hashOtp, issueSenderToken, setSenderCookie } from "@/lib/auth";
import { normaliseEmail } from "@/lib/email";
import { rememberIdentity } from "@/lib/identity";
import { dbOtpDirectory } from "@/lib/onboarding/db";
import { verifyEmailCode } from "@/lib/onboarding/email-code";

const bodySchema = z.object({
  email: z.string().trim().optional(),
  code: z.string().trim().optional(),
  phone: z.string().optional(),
});

/** Check the emailed code and start a session bound to that email only. */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.phone || !parsed.data.email) {
    return NextResponse.json(
      { error: "Sign in with your email address. Add the M-Pesa number afterwards; it is where prompts are sent, not how you sign in." },
      { status: 400 },
    );
  }
  const emailCheck = z.string().trim().email("Enter a valid email address").safeParse(parsed.data.email);
  const codeCheck = z.string().trim().regex(/^\d{6}$/, "The code is six digits").safeParse(parsed.data.code);
  if (!emailCheck.success) return NextResponse.json({ error: emailCheck.error.issues[0]?.message }, { status: 400 });
  if (!codeCheck.success) return NextResponse.json({ error: codeCheck.error.issues[0]?.message }, { status: 400 });
  const email = normaliseEmail(emailCheck.data);
  let result;
  try {
    result = await verifyEmailCode(dbOtpDirectory(), email, codeCheck.data, Date.now(), hashOtp);
  } catch (error) {
    console.error(`[otp] could not check a code: ${error instanceof Error ? error.message : "unavailable"}`);
    return NextResponse.json({ error: "Sign-in storage is not ready. Run the latest database migration." }, { status: 503 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  await rememberIdentity({ email });
  const response = NextResponse.json({ ok: true });
  setSenderCookie(response, issueSenderToken({ email }));
  return response;
}
