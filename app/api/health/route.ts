import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { publicClient } from "@/lib/chain";
import { db } from "@/lib/db";
import { listProjects } from "@/lib/project";

/**
 * Is the platform standing? Database, chain RPC, and every project's
 * contract, each reported separately so an alert names what fell over.
 */
export async function GET(): Promise<NextResponse> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await db().execute(sql`select 1`);
    checks.database = { ok: true };
  } catch (e) {
    checks.database = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  let chainOk = false;
  try {
    const id = await publicClient().getChainId();
    chainOk = true;
    checks.rpc = { ok: true, detail: `chain ${id}` };
  } catch (e) {
    checks.rpc = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  if (checks.database?.ok && chainOk) {
    try {
      const projects = await listProjects();
      for (const p of projects) {
        const code = await publicClient().getCode({ address: p.contractAddress });
        checks[`project:${p.id}`] = {
          ok: !!code && code !== "0x",
          detail: p.contractAddress,
        };
      }
      if (!projects.length) checks.projects = { ok: false, detail: "no projects" };
    } catch (e) {
      checks.projects = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json({ ok, checks, at: new Date().toISOString() }, { status: ok ? 200 : 503 });
}
