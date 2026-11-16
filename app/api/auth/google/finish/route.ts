import { NextResponse } from "next/server";

/** Older return path. Google now returns to /api/auth/google/callback. */
export function GET(request: Request): NextResponse {
  return NextResponse.redirect(new URL("/account", new URL(request.url).origin));
}
