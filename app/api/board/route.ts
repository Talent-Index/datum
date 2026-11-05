import { NextResponse } from "next/server";

import { readProjectState } from "@/lib/project-state";
import { listProjects } from "@/lib/project";

/**
 * Every build, with its escrow read beside it. One slow or failing contract
 * leaves that row unread and does not hide the others. No ?project= needed.
 */
export async function GET(): Promise<NextResponse> {
  const projects = await listProjects();
  const rows = await Promise.all(
    projects.map(async (project) => {
      try {
        return { id: project.id, state: await readProjectState(project), error: null as string | null };
      } catch (error) {
        return {
          id: project.id,
          state: null,
          error: error instanceof Error ? error.message : "This escrow could not be read",
        };
      }
    }),
  );
  return NextResponse.json({ projects: rows });
}
