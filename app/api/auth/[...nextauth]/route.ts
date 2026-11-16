import { NextResponse } from "next/server";

/** Auth.js is not used. Google sign-in is /api/auth/google. */
export function GET(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function POST(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
