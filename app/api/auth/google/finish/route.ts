import { NextResponse } from "next/server";

import { issueSenderToken, setSenderCookie } from "@/lib/auth";
import { auth } from "@/lib/google-auth";
import { linkGoogleIdentity } from "@/lib/identity";

/**
 * Google has proved the email. The cookie is for that email. The M-Pesa
 * number, if one is saved, stays a payment destination and is not the session.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  const origin = new URL(request.url).origin;
  if (!email) return NextResponse.redirect(new URL("/account", origin));
  const linked = await linkGoogleIdentity({
    email,
    googleSub: session.googleSub ?? null,
    name: session.user?.name ?? null,
  });
  const response = NextResponse.redirect(new URL("/account", origin));
  setSenderCookie(response, issueSenderToken({ email: linked.email }));
  return response;
}
