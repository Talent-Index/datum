import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let database: Database | null = null;

/**
 * Lazily constructed so importing this module never requires a database —
 * route handlers fail with a clear message at request time instead of at
 * build time.
 */
export function db(): Database {
  if (!database) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set; provision Postgres and run npm run db:migrate",
      );
    }
    pool = new Pool({ connectionString: url, max: 5 });
    database = drizzle(pool, { schema });
  }
  return database;
}

export function dbPool(): Pool {
  db();
  return pool!;
}

export { schema };
