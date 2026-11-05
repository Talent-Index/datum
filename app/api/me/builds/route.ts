import { NextResponse } from "next/server";

import { currentSender } from "@/lib/auth";
import { buildsForSession } from "@/lib/identity";

/** Builds tied to the signed-in phone, email, or an earlier visit. */
export async function GET(request: Request): Promise<NextResponse> {
  const session = currentSender(request);
  if (!session) return NextResponse.json({ projects: [] });
  const projects = await buildsForSession(session);
  return NextResponse.json({ projects });
}
