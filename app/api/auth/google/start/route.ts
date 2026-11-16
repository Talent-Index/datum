import { NextResponse } from "next/server";

/** Older entry point. The button now uses /api/auth/google. */
export function GET(request: Request): NextResponse {
  const url = new URL(request.url);
  const target = new URL("/api/auth/google", url.origin);
  const next = url.searchParams.get("next");
  if (next) target.searchParams.set("next", next);
  return NextResponse.redirect(target);
}
