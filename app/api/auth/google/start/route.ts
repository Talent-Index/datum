import { NextResponse } from "next/server";

import { googleSignInEnabled, signIn } from "@/lib/google-auth";

/** Starts Google sign-in. Hidden in the UI when the env vars are unset. */
export async function GET(): Promise<Response> {
  if (!googleSignInEnabled()) {
    return NextResponse.json({ error: "Google sign-in is not configured on this deployment" }, { status: 503 });
  }
  await signIn("google", { redirectTo: "/api/auth/google/finish" });
  return NextResponse.json({ ok: true });
}
