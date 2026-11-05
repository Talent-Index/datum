import { NextResponse } from "next/server";
import { z } from "zod";

import { currentSender } from "@/lib/auth";
import { rememberTouch } from "@/lib/identity";

const bodySchema = z.object({
  projectId: z.string().trim().min(3).max(40),
  kind: z.enum(["visit", "commit", "pay", "approve"]).default("visit"),
});

/** Remember which build this person opened, so the next sign-in can find it. */
export async function POST(request: Request): Promise<NextResponse> {
  const session = currentSender(request);
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send { projectId }" }, { status: 400 });
  await rememberTouch(session.phone ?? session.email, parsed.data.projectId, parsed.data.kind);
  return NextResponse.json({ ok: true });
}
