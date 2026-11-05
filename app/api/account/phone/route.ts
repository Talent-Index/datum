import { NextResponse } from "next/server";
import { z } from "zod";

import { currentAccount, publicAccount, setAccountPhone, friendlyError } from "@/lib/accounts";

const bodySchema = z.object({
  phone: z.string().trim().regex(/^(?:\+?254|0)7\d{8}$/, "Enter a Safaricom number such as 0712345678"),
});

/**
 * Save or replace the M-Pesa number prompts are sent to. The number is not
 * checked against a handset, and a number already saved on another account
 * is refused rather than merged.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  if (account.feeStatus === "pending") {
    return NextResponse.json({ error: "A fee prompt is still open. Wait until it finishes before changing the number." }, { status: 409 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  try {
    const updated = await setAccountPhone(account, parsed.data.phone);
    return NextResponse.json({ ok: true, account: publicAccount(updated), message: `Number saved. Prompts will go to ${updated.phone}. This does not prove you hold that handset.` });
  } catch (error) {
    return NextResponse.json({ error: friendlyError(error, "Could not save the number; try again") }, { status: 400 });
  }
}
