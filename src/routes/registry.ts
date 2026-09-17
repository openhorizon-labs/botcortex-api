/**
 * The public skill registry — the one door with no lock.
 *
 *   GET  /api/registry                  every published skill, grouped by arm
 *   GET  /api/registry?platform=        one arm's
 *   GET  /api/registry/skills/:id       one skill — what a share link opens
 *   POST /api/registry/skills/:id/ran   someone ran it in their browser
 *   GET  /api/registry/authors/:handle  an author's public page
 *
 * Read by the marketing site and by anyone curious. Rows carry the program,
 * its description, which arm it was proven on, how often other people have
 * run it, and its author's handle. An author is the name they signed up with
 * and what they have done in public — never an email, never an account id.
 */
import { createHash } from "node:crypto";

import { Hono } from "hono";

import type { Db } from "../db.js";
import type { AuthLike } from "../hono.js";
import { countRun, publishedAuthor, publishedSkill, publishedSkills } from "../registry.js";

const CACHE = "public, max-age=60, stale-while-revalidate=300";

/** Who is running, as far as counting needs to know: a hash that is the same
 *  for one browser for one day and means nothing the next. The address goes
 *  in and does not come out; nothing else about the visitor is kept. */
export function visitorFor(headers: Headers, day: string, salt: string): string {
  const address = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "local";
  const agent = headers.get("user-agent") ?? "";
  return createHash("sha256").update(`${salt}|${day}|${address}|${agent}`).digest("hex").slice(0, 32);
}

export function registryRoutes(db: Db, auth?: AuthLike, salt = process.env.BETTER_AUTH_SECRET ?? "botcortex") {
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
    c.header("Cache-Control", CACHE);
    return c.json({
      platforms: [...byPlatform].map(([name, skills]) => ({ name, skills })),
      count: rows.length,
    });
  });

  app.get("/registry/skills/:id", async (c) => {
    const row = await publishedSkill(db, c.req.param("id"));
    if (!row) return c.json({ error: "no such published skill" }, 404);
    c.header("Cache-Control", CACHE);
    return c.json({ skill: row });
  });

  app.post("/registry/skills/:id/ran", async (c) => {
    // A signed-in author is recognised so their own runs are not votes; a
    // visitor with no session is the normal case and needs none.
    const session = auth ? await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null) : null;
    const viewerId = session ? (session.user as { id: string }).id : null;
    const day = new Date().toISOString().slice(0, 10);
    const outcome = await countRun(db, c.req.param("id"), visitorFor(c.req.raw.headers, day, salt), day, viewerId);
    if (!outcome) return c.json({ error: "no such published skill" }, 404);
    return c.json(outcome);
  });

  app.get("/registry/authors/:handle", async (c) => {
    const page = await publishedAuthor(db, c.req.param("handle"));
    if (!page) return c.json({ error: "no such author" }, 404);
    c.header("Cache-Control", CACHE);
    return c.json(page);
  });

  return app;
}
