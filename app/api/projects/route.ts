import { NextResponse } from "next/server";
import { z } from "zod";

import { isOperator } from "@/lib/auth";
import { STAGES } from "@/lib/evidence/classifier";
import { createProject, listProjects } from "@/lib/project";

/** Every project, for the index page and for anyone choosing one. */
export async function GET(): Promise<NextResponse> {
  const projects = await listProjects();
  return NextResponse.json({
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      developer_name: p.developerName,
      contract: p.contractAddress,
      is_remittance: p.senderPhone !== null,
      funding_target: p.fundingTargetKes ?? 0,
      milestones: p.milestones.length,
    })),
  });
}

const bodySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,40}$/, "id: 3-40 lowercase letters, digits, hyphens"),
  name: z.string().trim().min(3).max(120),
  developerName: z.string().trim().min(2).max(120),
  projectRef: z.string().trim().max(60).optional(),
  latitude: z.number().min(-5).max(5),
  longitude: z.number().min(33).max(42),
  developerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "developerAddress must be a 0x address"),
  senderPhone: z.string().trim().regex(/^(?:\+?254|0)7\d{8}$/).optional().or(z.literal("")),
  fundingTargetKes: z.number().int().positive().optional(),
  stallAfterDays: z.number().int().min(1).max(365).optional(),
  milestones: z
    .array(
      z.object({
        description: z.string().trim().min(3).max(120),
        stage: z.enum(STAGES),
        percent: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(12),
});

/**
 * Create a project and deploy its escrow. Operator only: this spends the
 * platform wallet's gas and settlement float, and bakes a milestone schedule
 * into a contract that cannot be changed afterward.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isOperator(request)) {
    return NextResponse.json({ error: "Operator access required" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid project" }, { status: 400 });
  }
  const input = parsed.data;
  try {
    const project = await createProject({
      id: input.id,
      name: input.name,
      developerName: input.developerName,
      projectRef: input.projectRef || null,
      latitude: input.latitude,
      longitude: input.longitude,
      developerAddress: input.developerAddress as `0x${string}`,
      senderPhone: input.senderPhone || null,
      fundingTargetKes: input.fundingTargetKes ?? null,
      stallAfterSeconds: (input.stallAfterDays ?? 30) * 24 * 3600,
      milestones: input.milestones,
    });
    return NextResponse.json({
      ok: true,
      id: project.id,
      contract: project.contractAddress,
      kes: project.kesAddress,
      message: `${project.name} is live at ${project.contractAddress}.`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project creation failed" },
      { status: 400 },
    );
  }
}
