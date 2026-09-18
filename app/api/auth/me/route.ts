import { NextResponse } from "next/server";

import { currentSender, isOperator } from "@/lib/auth";
import { currentAccount, publicAccount } from "@/lib/accounts";

/** Who the browser is, so the pages can render the right controls. */
export async function GET(request: Request): Promise<NextResponse> {
  const sender = currentSender(request);
  const account = sender ? await currentAccount(request) : null;
  return NextResponse.json({
    sender: sender ? { phone: sender.phone, expiresAt: sender.expiresAt } : null,
    account: account ? publicAccount(account) : null,
    operator: isOperator(request),
  });
}
