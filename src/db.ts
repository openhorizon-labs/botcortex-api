/**
 * Database wiring — Supabase Postgres in real deployments, PGlite for
 * credential-free local dev and tests.
 *
 *   DATABASE_URL=postgresql://…   Supabase pooler URI (prepare must stay false)
 *   DATABASE_URL=pglite://memory  in-process Postgres, migrations auto-applied
 *   DATABASE_URL=pglite://.data   same, persisted to a local directory
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./auth-schema.js";

export type Db = PostgresJsDatabase<typeof schema> | PgliteDatabase<typeof schema>;

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set — Supabase pooler URI, or pglite://memory for local dev (see .env.example)",
  );
}

async function applyMigrations(exec: (sql: string) => Promise<unknown>) {
  const dir = join(import.meta.dir, "..", "drizzle");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(join(dir, file), "utf8").split(
      "--> statement-breakpoint",
    )) {
      await exec(statement);
    }
  }
}

export const db: Db = await (async () => {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const target = url.replace(/^pglite:\/\/?/, "");
    const pglite = target && target !== "memory" ? new PGlite(target) : new PGlite();
    await applyMigrations((sql) => pglite.exec(sql));
    console.log(`db: PGlite (${target || "memory"}) — dev mode, migrations applied`);
    return drizzle(pglite, { schema });
  }
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { default: postgres } = await import("postgres");
  return drizzle(postgres(url, { prepare: false }), { schema });
})();
