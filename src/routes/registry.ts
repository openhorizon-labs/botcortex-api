/**
 * The public skill registry — the one door with no lock.
 *
 *   GET /api/registry            every published skill, grouped by arm
 *   GET /api/registry?platform=  one arm's
 *
 * Read by the marketing site's /skills page at build and on a timer, and by
 * anyone curious. Rows carry the program, its description, which arm it was
 * proven on and when; never who taught it.
 */
import { Hono } from "hono";

import type { Db } from "../db.js";
import { publishedSkills } from "../registry.js";

export function registryRoutes(db: Db) {
  const app = new Hono();

  app.get("/registry", async (c) => {
    const platform = c.req.query("platform") || undefined;
    const rows = await publishedSkills(db, platform);
    const byPlatform = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byPlatform.get(row.platform) ?? [];
      list.push(row);
      byPlatform.set(row.platform, list);
    }
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({
      platforms: [...byPlatform].map(([name, skills]) => ({ name, skills })),
      count: rows.length,
    });
  });

  return app;
}
