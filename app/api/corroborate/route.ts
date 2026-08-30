import { NextResponse } from "next/server";
import { z } from "zod";

import { corroborate } from "@/lib/data/corroborate";
import { db, schema } from "@/lib/db";
import {
  DEVELOPER_NAME,
  PROJECT_ID,
  PROJECT_REF,
  SITE_LAT,
  SITE_LON,
  SITE_NAME,
  ensureProject,
} from "@/lib/project";

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
  const developer = parsed.data.developer ?? DEVELOPER_NAME;

  await ensureProject();

  const result = await corroborate(
    SITE_NAME,
    developer,
    SITE_LAT,
    SITE_LON,
    developer === DEVELOPER_NAME ? PROJECT_REF : null,
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
    projectId: PROJECT_ID,
    developerName: developer,
    verdict: result.verdict,
    result: wire,
  });

  return NextResponse.json(wire);
}
