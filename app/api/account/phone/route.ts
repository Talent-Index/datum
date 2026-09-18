import { NextResponse } from "next/server";
import { z } from "zod";

import { currentAccount, publicAccount, setAccountPhone } from "@/lib/accounts";

const bodySchema = z.object({
  phone: z.string().trim().regex(/^(?:\+?254|0)7\d{8}$/, "Enter a Safaricom number such as 0712345678"),
});

/**
 * An email account adds the M-Pesa number it will pay from. It is not
 * proven here; the fee paid from it is the proof, because an STK prompt can
 * only be approved on that handset.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const account = await currentAccount(request);
  if (!account) return NextResponse.json({ error: "Open an account first" }, { status: 401 });
  if (account.phoneVerified && account.phone) {
    return NextResponse.json({ error: "This account's number is already verified" }, { status: 409 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  try {
    const updated = await setAccountPhone(account, parsed.data.phone);
    return NextResponse.json({ ok: true, account: publicAccount(updated), message: `Number saved. The KES fee prompt will go to ${updated.phone}.` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save the number" }, { status: 400 });
  }
}
