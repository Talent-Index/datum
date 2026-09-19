import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { currentAccount, publicAccount, setAccountEmail, friendlyError } from "@/lib/accounts";
import { hashOtp, otpTestCodeAccepted } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { normaliseEmail } from "@/lib/email";
import { logActivity } from "@/lib/registry";

const bodySchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{6}$/, "The code is six digits"),
});
const MAX_ATTEMPTS = 5;

export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const email = normaliseEmail(parsed.data.email);
  const database = db();
  const [row] = await database.select().from(schema.otpCodes).where(eq(schema.otpCodes.phone, email));
  const demo = otpTestCodeAccepted("email", parsed.data.code);
  if (!demo) {
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: "No live code for this email; request a new one" }, { status: 400 });
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await database.delete(schema.otpCodes).where(eq(schema.otpCodes.id, row.id));
      return NextResponse.json({ error: "Too many wrong attempts; request a new code" }, { status: 429 });
    }
    if (row.codeHash !== hashOtp(email, parsed.data.code)) {
      await database.update(schema.otpCodes).set({ attempts: row.attempts + 1 }).where(eq(schema.otpCodes.id, row.id));
      return NextResponse.json({ error: `Wrong code; ${MAX_ATTEMPTS - row.attempts - 1} attempt(s) left` }, { status: 400 });
    }
  }
  if (row) await database.delete(schema.otpCodes).where(eq(schema.otpCodes.id, row.id));
  try {
    const updated = await setAccountEmail(account, email, true);
    await logActivity({ accountId: account.id, actorAddress: account.address as `0x${string}`, kind: "email.verified", payload: { emailHash: hashOtp(email, "email") } });
    return NextResponse.json({ ok: true, account: publicAccount(updated), message: `${email} is now on your account.` });
  } catch (error) {
    return NextResponse.json({ error: friendlyError(error, "Could not attach the email; try again") }, { status: 400 });
  }
}
