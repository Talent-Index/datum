import { NextResponse } from "next/server";
import { z } from "zod";

import { corroborate } from "@/lib/data/corroborate";
import { db, schema } from "@/lib/db";
import { missingProjectMessage, resolveProject } from "@/lib/project";

const bodySchema = z.object({ developer: z.string().min(1).max(200).optional() });

/**
 * Check the site and the company against public records. Runs from the
 * cache, so it works offline; warm the cache to hit the real endpoints.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Body may name a developer" }, { status: 400 });
  }
  const project = await resolveProject(request);
  if (!project) {
    return NextResponse.json({ error: await missingProjectMessage(request) }, { status: 400 });
  }
  const developer = parsed.data.developer ?? project.developerName;

  const result = await corroborate(
    project.name,
    developer,
    project.latitude,
    project.longitude,
    developer === project.developerName ? project.projectRef : null,
  );

  const wire = {
    developer,
    verdict: result.verdict,
    corroborating: result.corroborating,
    findings: result.findings,
    unavailable: result.unavailable,
    buildings: result.footprint?.buildingCount ?? null,
    under_construction: result.footprint?.buildingsUnderConstruction ?? null,
    drift_m: result.location?.driftM ?? null,
  };

  await db().insert(schema.corroborations).values({
    projectId: project.id,
    developerName: developer,
    verdict: result.verdict,
    result: wire,
  });

  return NextResponse.json(wire);
}
