import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NextResponse } from "next/server";
import { toHex } from "viem";

import {
  WRITE_GAS,
  escrowAbi,
  escrowAddress,
  oracleWallet,
  publicClient,
  revertReason,
} from "@/lib/chain";
import { db, dbPool, schema } from "@/lib/db";
import { stageClassifier } from "@/lib/evidence/classifier";
import { PostgresSeenHashStore } from "@/lib/evidence/store";
import { EvidenceVerifier, type Verdict } from "@/lib/evidence/verifier";
import {
  MILESTONES,
  PROJECT_ID,
  SITE_LAT,
  SITE_LON,
  SITE_NAME,
  ensureProject,
} from "@/lib/project";

/**
 * Developer uploads site photographs; the pipeline rules on them and, when
 * they pass, the oracle countersigns on chain. One of two signatures — the
 * surveyor or the platform completes the release via /api/attest.
 */

// Rejected on the Content-Length header before any parsing: a 40MB drone
// still would exhaust function memory before a single check runs.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Hosted vision classification runs tens of seconds per image, in parallel
// across the submission. The platform default of ten seconds cuts it off.
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error:
          `Upload is ${(contentLength / 1e6).toFixed(1)}MB; the limit is ` +
          `${MAX_UPLOAD_BYTES / 1e6}MB. Resize the photographs before submitting.`,
      },
      { status: 413 },
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { error: "Send multipart form data with one or more files under 'images'" },
      { status: 400 },
    );
  }
  const files = form.getAll("images").filter((f): f is File => f instanceof File);
  if (!files.length) {
    return NextResponse.json(
      { error: "No files under 'images'; attach the site photographs" },
      { status: 400 },
    );
  }

  await ensureProject();

  const chain = publicClient();
  const milestoneId = Number(
    await chain.readContract({
      address: escrowAddress(),
      abi: escrowAbi,
      functionName: "nextMilestone",
    }),
  );
  if (milestoneId >= MILESTONES.length) {
    return NextResponse.json({ error: "All milestones complete" }, { status: 400 });
  }
  const claimedStage = MILESTONES[milestoneId]!.stage;

  const dir = await mkdtemp(join(tmpdir(), "evidence-"));
  let verdict: Verdict;
  let store: PostgresSeenHashStore | null = null;
  try {
    const paths: string[] = [];
    for (const file of files) {
      const path = join(dir, basename(file.name).replace(/[^\w.-]/g, "_"));
      await writeFile(path, Buffer.from(await file.arrayBuffer()));
      paths.push(path);
      // The sidecar backend reads label files; accept them alongside the
      // images so demos stay deterministic without the model.
      const sidecar = form.get(`${file.name}.stage`);
      if (typeof sidecar === "string") {
        await writeFile(`${path}.stage`, sidecar);
      }
    }

    store = new PostgresSeenHashStore(dbPool());
    const verifier = new EvidenceVerifier(stageClassifier(), store);
    verdict = await verifier.verify(
      { projectId: PROJECT_ID, name: SITE_NAME, latitude: SITE_LAT, longitude: SITE_LON },
      milestoneId,
      claimedStage,
      paths,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  let txHash: string | null = null;
  if (verdict.accepted) {
    try {
      const { client, account } = oracleWallet();
      const hash = await client.writeContract({
        address: escrowAddress(),
        abi: escrowAbi,
        functionName: "attest",
        args: [BigInt(milestoneId), 0, verdict.evidenceHash as `0x${string}`],
        account,
        chain: client.chain,
        gas: WRITE_GAS,
      });
      await publicClient().waitForTransactionReceipt({ hash });
      txHash = hash;
    } catch (error) {
      // The photographs were recorded as seen when the checks passed, but
      // without an attestation this milestone has no evidence on chain.
      // Release the hashes so the same photographs can be resubmitted once
      // the cause is fixed, rather than being rejected as duplicates forever.
      await store?.forget(
        PROJECT_ID,
        verdict.images.filter((i) => i.passed).map((i) => BigInt(`0x${i.phash}`)),
      );
      return NextResponse.json(
        { error: `Evidence accepted but the oracle attestation failed: ${revertReason(error)}` },
        { status: 502 },
      );
    }
  }

  await db().insert(schema.attestations).values({
    projectId: PROJECT_ID,
    milestoneIndex: milestoneId,
    role: 0,
    evidenceHash: verdict.accepted ? verdict.evidenceHash : toHex(new Uint8Array(32)),
    accepted: verdict.accepted,
    summary: verdict.summary,
    verdict: toWireVerdict(verdict),
    txHash,
  });

  // Accepted image hashes are already persisted to evidence_images by the
  // verifier's seen-hash store; a second insert here would double-count.

  return NextResponse.json(toWireVerdict(verdict));
}

/** Same wire shape as the reference implementation's verdict dictionary. */
function toWireVerdict(v: Verdict): Record<string, unknown> {
  return {
    project_id: v.projectId,
    milestone_id: v.milestoneId,
    claimed_stage: v.claimedStage,
    accepted: v.accepted,
    evidence_hash: v.evidenceHash,
    images: v.images.map((i) => ({
      filename: i.filename,
      sha256: i.sha256,
      phash: i.phash,
      passed: i.passed,
      checks: i.checks,
      notes: i.notes,
      failures: i.failures,
    })),
    summary: v.summary,
  };
}
