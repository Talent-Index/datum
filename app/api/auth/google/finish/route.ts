import { NextResponse } from "next/server";

import { issueSenderToken, setSenderCookie } from "@/lib/auth";
import { auth } from "@/lib/google-auth";
import { linkGoogleIdentity } from "@/lib/identity";

/**
 * Google has proved the email. Issue the same Datum cookie the SMS and
 * email codes use, preferring the phone already linked to that email.
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
  const response = NextResponse.redirect(new URL(linked.phone ? "/buy" : "/account", origin));
  setSenderCookie(response, issueSenderToken(linked.phone ? { phone: linked.phone, email: linked.email } : { email: linked.email }));
  return response;
}
