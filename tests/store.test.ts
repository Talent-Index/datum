import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresSeenHashStore } from "@/lib/evidence/store";

/**
 * The novelty comparison runs in SQL so it is consistent across serverless
 * instances. PGlite is real Postgres compiled to WASM, so the exact
 * bit_count expression the production store issues runs here, offline —
 * against the schema produced by the committed Drizzle migrations, so the
 * store and the schema cannot drift apart unnoticed.
 */

let db: PGlite;
let store: PostgresSeenHashStore;

beforeAll(async () => {
  db = new PGlite();
  const migrationsDir = join(process.cwd(), "drizzle");
  const migrations = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      await db.exec(statement);
    }
  }
  store = new PostgresSeenHashStore(db);
});

afterAll(async () => {
  await db.close();
});

describe("Postgres seen-hash store", () => {
  const base = 0xd9e09ec7fe182324n;

  it("finds a hash within the Hamming threshold", async () => {
    await store.remember("proj-a", base, "milestone 0");
    // Flip six bits — exactly at the threshold.
    const withinThreshold = base ^ 0b111111n;
    expect(await store.duplicateOf("proj-a", withinThreshold)).toBe("milestone 0");
  });

  it("does not match beyond the threshold", async () => {
    const beyondThreshold = base ^ 0b1111111n; // seven bits
    expect(await store.duplicateOf("proj-a", beyondThreshold)).toBeNull();
  });

  it("scopes hashes to their project", async () => {
    expect(await store.duplicateOf("proj-b", base)).toBeNull();
  });

  it("round-trips hashes with the top bit set through signed BIGINT", async () => {
    const topBit = 0xffff_0000_ffff_0000n; // negative as a signed 64-bit value
    await store.remember("proj-c", topBit, "milestone 3");
    expect(await store.duplicateOf("proj-c", topBit)).toBe("milestone 3");
    expect(await store.duplicateOf("proj-c", topBit ^ 0b11n)).toBe("milestone 3");
  });
});
