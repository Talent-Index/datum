import { NextResponse } from "next/server";

import { issueSenderToken, setSenderCookie } from "@/lib/auth";
import { finishGoogleSignIn, GOOGLE_STATE_COOKIE, googleStateCookieOptions } from "@/lib/google-auth";

export const runtime = "nodejs";

/** Exchange the Google code, then issue the same email session a code would. */
export async function GET(request: Request): Promise<NextResponse> {
  const result = await finishGoogleSignIn(request);
  const response = NextResponse.redirect(result.location);
  const cleared = { ...googleStateCookieOptions(), maxAge: 0 };
  response.cookies.set(GOOGLE_STATE_COOKIE, "", cleared);
  if (result.email) setSenderCookie(response, issueSenderToken({ email: result.email }));
  return response;
}
