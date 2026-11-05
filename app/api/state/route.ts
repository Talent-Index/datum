import { NextResponse } from "next/server";

import { readProjectState } from "@/lib/project-state";
import { missingProjectMessage, resolveProject } from "@/lib/project";

/** What a buyer, the platform, and a judge all look at: one live project. */
export async function GET(request: Request): Promise<NextResponse> {
  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: await missingProjectMessage(request) }, { status: 400 });
  }
  return NextResponse.json(await readProjectState(project));
}
