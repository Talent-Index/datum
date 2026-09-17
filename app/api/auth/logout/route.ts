import { NextResponse } from "next/server";

import { clearOperatorCookie, clearSenderCookie } from "@/lib/auth";

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  clearSenderCookie(response);
  clearOperatorCookie(response);
  return response;
}
