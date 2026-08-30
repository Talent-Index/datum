import { PHASH_DISTANCE_THRESHOLD, hamming, phashToSigned, signedToPhash } from "./phash";

/** Satisfied by pg.Pool, pg.Client, and PGlite alike. */
export interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * The store of perceptual hashes already accepted for a project, so a
 * resubmitted photograph is caught. The reference implementation kept these
 * in a process-local dict, which breaks across serverless instances — one
 * instance accepts a photo, the next instance has never seen it. Postgres is
 * the durable backend; the memory store serves tests and single-process use.
 */

export interface SeenHashStore {
  remember(projectId: string, phash: bigint, label: string): Promise<void>;
  duplicateOf(projectId: string, phash: bigint): Promise<string | null>;
}

export class MemorySeenHashStore implements SeenHashStore {
  private seen = new Map<string, Array<{ phash: bigint; label: string }>>();

  async remember(projectId: string, phash: bigint, label: string): Promise<void> {
    const entries = this.seen.get(projectId) ?? [];
    entries.push({ phash, label });
    this.seen.set(projectId, entries);
  }

  async duplicateOf(projectId: string, phash: bigint): Promise<string | null> {
    for (const entry of this.seen.get(projectId) ?? []) {
      if (hamming(entry.phash, phash) <= PHASH_DISTANCE_THRESHOLD) {
        return entry.label;
      }
    }
    return null;
  }

  clear(): void {
    this.seen.clear();
  }
}

/**
 * Hashes live in evidence_images.phash as BIGINT (the unsigned 64-bit hash
 * mapped into the signed range) and the Hamming comparison runs in SQL, so
 * the check is consistent no matter which instance handles the upload.
 */
export class PostgresSeenHashStore implements SeenHashStore {
  constructor(private readonly db: Queryable) {}

  async remember(projectId: string, phash: bigint, label: string): Promise<void> {
    await this.db.query(
      `insert into evidence_images (project_id, phash, label) values ($1, $2, $3)`,
      [projectId, phashToSigned(phash).toString(), label],
    );
  }

  async duplicateOf(projectId: string, phash: bigint): Promise<string | null> {
    // bit_count() exists for bit and bytea only, so the XOR result is cast
    // to bit(64); Postgres has no popcount directly on bigint.
    const result = await this.db.query(
      `select label from evidence_images
       where project_id = $1 and bit_count((phash # $2)::bit(64)) <= $3
       limit 1`,
      [projectId, phashToSigned(phash).toString(), PHASH_DISTANCE_THRESHOLD],
    );
    const row = result.rows[0] as { label: string } | undefined;
    return row?.label ?? null;
  }
}

export { signedToPhash };
