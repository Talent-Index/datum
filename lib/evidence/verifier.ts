import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { haversineMetres, readExif } from "./exif";
import { PHASH_DISTANCE_THRESHOLD, phash, phashToHex } from "./phash";
import { SidecarClassifier, type StageClassifier } from "./classifier";
import { MemorySeenHashStore, type SeenHashStore } from "./store";

/**
 * Evidence verification for construction milestones.
 *
 * This is the part of the product that is actually hard to copy. The escrow
 * contract is a weekend of Solidity; the reason a developer pays you and a
 * bank trusts you is that the photographs backing each release survive
 * scrutiny.
 *
 * Four checks run on every submitted image:
 *
 *   1. location — EXIF GPS inside the geofence for this site
 *   2. recency  — capture timestamp within the reporting window
 *   3. novelty  — perceptual hash not seen on this project before, which
 *                 catches a photo resubmitted from an earlier milestone or
 *                 lifted from another site
 *   4. stage    — the visible construction stage matches what is claimed
 */

export { PHASH_DISTANCE_THRESHOLD };

export const DEFAULT_GEOFENCE_METRES = 150;
export const DEFAULT_MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Site {
  projectId: string;
  name: string;
  latitude: number;
  longitude: number;
  geofenceMetres?: number;
  maxAgeDays?: number;
}

export interface ImageFinding {
  filename: string;
  sha256: string;
  phash: string;
  passed: boolean;
  checks: Record<string, boolean>;
  notes: string[];
  failures: string[];
}

export interface Verdict {
  projectId: string;
  milestoneId: number;
  claimedStage: string;
  accepted: boolean;
  evidenceHash: string;
  images: ImageFinding[];
  summary: string;
}

function formatMetres(distance: number): string {
  return Math.round(distance).toLocaleString("en-US");
}

function spaced(stage: string): string {
  return stage.replace(/_/g, " ");
}

export class EvidenceVerifier {
  constructor(
    private readonly classifier: StageClassifier = new SidecarClassifier(),
    private readonly store: SeenHashStore = new MemorySeenHashStore(),
  ) {}

  async verify(
    site: Site,
    milestoneId: number,
    claimedStage: string,
    paths: string[],
    now: Date = new Date(),
    minImages = 3,
  ): Promise<Verdict> {
    const geofence = site.geofenceMetres ?? DEFAULT_GEOFENCE_METRES;
    const maxAgeDays = site.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;

    const findings: ImageFinding[] = [];
    const hashes: bigint[] = [];

    // Classify every frame concurrently. A hosted vision model takes tens of
    // seconds per image, and a submission is three or more; run serially and
    // the request outlives the platform's function timeout.
    const classifications = await Promise.all(paths.map((p) => this.classifier.classify(p)));

    for (const [index, path] of paths.entries()) {
      const data = await readFile(path);
      const sha = createHash("sha256").update(data).digest("hex");
      const hash = await phash(data);
      hashes.push(hash);

      const exif = await readExif(data);
      const checks: Record<string, boolean> = {};
      const notes: string[] = [];

      // 1. Location
      if (exif.gps === null) {
        checks.location = false;
        notes.push("No GPS data in image metadata");
      } else {
        const distance = haversineMetres(exif.gps, [site.latitude, site.longitude]);
        checks.location = distance <= geofence;
        if (!checks.location) {
          notes.push(`Captured ${formatMetres(distance)}m from the registered site`);
        } else {
          notes.push(`Within ${formatMetres(distance)}m of the registered site`);
        }
      }

      // 2. Recency
      const captured = exif.capturedAt;
      if (captured === null) {
        checks.recency = false;
        notes.push("No capture timestamp in image metadata");
      } else {
        const ageMs = now.getTime() - captured.getTime();
        checks.recency = ageMs >= 0 && ageMs <= maxAgeDays * DAY_MS;
        const ageDays = Math.floor(ageMs / DAY_MS);
        if (ageMs < 0) {
          notes.push("Capture timestamp is in the future");
        } else if (!checks.recency) {
          notes.push(`Captured ${ageDays} days ago, outside the reporting window`);
        } else {
          notes.push(`Captured ${ageDays} days ago`);
        }
      }

      // 3. Novelty
      const duplicate = await this.store.duplicateOf(site.projectId, hash);
      checks.novelty = duplicate === null;
      if (duplicate) {
        notes.push(`Matches an image already submitted for ${duplicate}`);
      }

      // 4. Stage
      const { stage, confidence } = classifications[index]!;
      checks.stage = stage === claimedStage && confidence >= 0.6;
      if (stage === "unknown") {
        notes.push("Stage could not be determined");
      } else if (!checks.stage) {
        notes.push(`Shows ${spaced(stage)}, not ${spaced(claimedStage)}`);
      } else {
        notes.push(`Shows ${spaced(stage)} (${Math.round(confidence * 100)}% confidence)`);
      }

      // Notes are appended in check order, and the novelty check adds no
      // note when it passes, so walk the two lists together and collect the
      // note of every failed check. (The reference implementation zipped
      // notes against all four check values, which silently dropped the
      // stage note from failures whenever novelty passed — its own spec,
      // "a rejection summary names only what failed", describes this
      // corrected pairing.)
      const failures: string[] = [];
      let noteIndex = 0;
      for (const [name, ok] of Object.entries(checks)) {
        if (name === "novelty" && ok) continue;
        const note = notes[noteIndex++];
        if (note !== undefined && !ok) failures.push(note);
      }

      findings.push({
        filename: basename(path),
        sha256: sha,
        phash: phashToHex(hash),
        passed: Object.values(checks).every(Boolean),
        checks,
        notes,
        failures,
      });
    }

    const clean = findings.filter((f) => f.passed);
    const accepted = clean.length >= minImages;

    if (accepted) {
      for (let i = 0; i < findings.length; i++) {
        if (findings[i]!.passed) {
          await this.store.remember(site.projectId, hashes[i]!, `milestone ${milestoneId}`);
        }
      }
    }

    const evidenceHash = bundleHash(site, milestoneId, claimedStage, findings);

    let summary: string;
    if (accepted) {
      summary = `${clean.length} of ${findings.length} images verified. Milestone evidence accepted.`;
    } else {
      const reasons = [...new Set(findings.flatMap((f) => f.failures))].sort();
      summary =
        `${clean.length} of ${findings.length} images passed, ${minImages} required. ` +
        reasons.slice(0, 2).join("; ") +
        (reasons.length ? "." : "");
    }

    return {
      projectId: site.projectId,
      milestoneId,
      claimedStage,
      accepted,
      evidenceHash,
      images: findings,
      summary,
    };
  }
}

/**
 * Deterministic hash over the whole submission. This is what gets written on
 * chain, so anyone holding the original images can prove later that the
 * record was never altered. The serialization must match the reference
 * implementation byte for byte: keys sorted at every level, no whitespace,
 * floats in shortest round-trip form — which JSON.stringify and Python's
 * json.dumps agree on for IEEE doubles.
 */
export function bundleHash(
  site: Site,
  milestoneId: number,
  stage: string,
  findings: ImageFinding[],
): string {
  const payload = {
    project_id: site.projectId,
    milestone_id: milestoneId,
    claimed_stage: stage,
    site: [site.latitude, site.longitude],
    images: findings
      .map((f) => ({ sha256: f.sha256, phash: f.phash, passed: f.passed }))
      .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0)),
  };
  const blob = canonicalJson(payload);
  return "0x" + createHash("sha256").update(blob).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v));
  return "{" + entries.join(",") + "}";
}
