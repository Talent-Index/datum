import { NextResponse } from "next/server";

import { beginGoogleSignIn, GOOGLE_STATE_COOKIE, googleStateCookieOptions } from "@/lib/google-auth";

export const runtime = "nodejs";

/** Send the browser to Google with a signed state cookie and PKCE. */
export function GET(request: Request): NextResponse {
  let begun: ReturnType<typeof beginGoogleSignIn>;
  try {
    begun = beginGoogleSignIn(request);
  } catch {
    const base = new URL(request.url).origin;
    return NextResponse.redirect(new URL("/account?google=failed", base));
  }
  const response = NextResponse.redirect(begun.location);
  if (begun.cookie) response.cookies.set(GOOGLE_STATE_COOKIE, begun.cookie, googleStateCookieOptions());
  return response;
}
