import { NextResponse } from "next/server";

import { currentSender, isOperator } from "@/lib/auth";

/** Who the browser is, so the pages can render the right controls. */
export async function GET(request: Request): Promise<NextResponse> {
  const sender = currentSender(request);
  return NextResponse.json({
    sender: sender ? { phone: sender.phone, expiresAt: sender.expiresAt } : null,
    operator: isOperator(request),
  });
}
