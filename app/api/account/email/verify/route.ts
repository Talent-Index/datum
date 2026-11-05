import { NextResponse } from "next/server";
import { z } from "zod";

import { currentAccount, friendlyError, publicAccount, setAccountEmail } from "@/lib/accounts";
import { hashOtp } from "@/lib/auth";
import { normaliseEmail } from "@/lib/email";
import { dbOtpDirectory } from "@/lib/onboarding/db";
import { verifyEmailCode } from "@/lib/onboarding/email-code";
import { logActivity } from "@/lib/registry";

const bodySchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{6}$/, "The code is six digits"),
});

/** Attach an email only after its code checks out. A mismatch does not merge accounts. */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const email = normaliseEmail(parsed.data.email);
  const result = await verifyEmailCode(dbOtpDirectory(), email, parsed.data.code, Date.now(), hashOtp);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  try {
    const updated = await setAccountEmail(account, email, true);
    await logActivity({ accountId: account.id, actorAddress: account.address as `0x${string}`, kind: "email.verified", payload: { emailHash: hashOtp(email, "email") } });
    return NextResponse.json({ ok: true, account: publicAccount(updated), message: `${email} is now on your account.` });
  } catch (error) {
    return NextResponse.json({ error: friendlyError(error, "Could not attach the email; try again") }, { status: 400 });
  }
}
