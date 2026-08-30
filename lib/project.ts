import { eq } from "drizzle-orm";

import { db, schema } from "./db";

/**
 * The live project. One development per escrow contract; multi-project
 * support means one row and one contract address per project, which the
 * schema already carries.
 */

export const PROJECT_ID = "willow-park-a";
export const SITE_NAME = "Willow Park Block A, Kilimani";
export const SITE_LAT = -1.2921;
export const SITE_LON = 36.7827;
export const DEVELOPER_NAME = "Willow Park Developments Ltd";
export const PROJECT_REF = "EBK/PR/2026/00812";

export const MILESTONES: Array<{ description: string; stage: string; percent: number }> = [
  { description: "Site clearing and foundation", stage: "foundation", percent: 20 },
  { description: "Ground floor slab", stage: "ground_slab", percent: 20 },
  { description: "First floor structure", stage: "superstructure", percent: 20 },
  { description: "Roofing complete", stage: "roofing", percent: 20 },
  { description: "Finishing and handover", stage: "finishing", percent: 20 },
];

export const ROLE_NAMES: Record<number, string> = {
  0: "Evidence pipeline",
  1: "Quantity surveyor",
  2: "Platform",
};

let ensured = false;

/** Idempotent seed so a fresh database serves the demo project immediately. */
export async function ensureProject(): Promise<void> {
  if (ensured) return;
  const database = db();
  const existing = await database
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, PROJECT_ID));
  if (!existing.length) {
    await database.insert(schema.projects).values({
      id: PROJECT_ID,
      name: SITE_NAME,
      developerName: DEVELOPER_NAME,
      projectRef: PROJECT_REF,
      latitude: SITE_LAT,
      longitude: SITE_LON,
      contractAddress: process.env.ESCROW_ADDRESS ?? null,
    });
    await database.insert(schema.milestones).values(
      MILESTONES.map((m, i) => ({
        projectId: PROJECT_ID,
        milestoneIndex: i,
        description: m.description,
        stage: m.stage,
        percent: m.percent,
      })),
    );
  }
  ensured = true;
}
