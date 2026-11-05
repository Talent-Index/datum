import { NextResponse } from "next/server";

import { currentAccount, publicAccount } from "@/lib/accounts";
import { currentSender, isOperator } from "@/lib/auth";
import { googleSignInEnabled } from "@/lib/google-auth";

/** Who the browser is, so the pages can render the right controls. */
export async function GET(request: Request): Promise<NextResponse> {
  const sender = currentSender(request);
  const account = sender ? await currentAccount(request) : null;
  return NextResponse.json({
    sender: sender ? { phone: sender.phone, email: sender.email, expiresAt: sender.expiresAt } : null,
    account: account ? publicAccount(account) : null,
    operator: isOperator(request),
    google: googleSignInEnabled(),
  });
}
