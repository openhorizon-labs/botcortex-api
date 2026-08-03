/**
 * Routes the WEB APP calls, authenticated by the Better Auth session cookie.
 *
 * These reach us through the Next rewrite in the web repo, which is what
 * keeps the cookie first-party — fetching this origin directly from the
 * browser sends no cookie and lands on a 401.
 */
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Db } from "../db.js";
import type { AuthLike } from "../hono.js";
import { SIGNUP_GRANT_MICROS, balanceFor, formatMicros, grant } from "../credits.js";
import { mintKey } from "../keys.js";
import { ALLOWED_MODELS } from "../pricing.js";
import { message, robot, robotKey } from "../app-schema.js";

type Env = { Variables: { userId: string } };

export function accountRoutes(auth: AuthLike, db: Db) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", (session.user as { id: string }).id);
    await next();
  });

  app.get("/keys", async (c) => {
    const keys = await db
      .select({
        id: robotKey.id,
        name: robotKey.name,
        prefix: robotKey.prefix,
        createdAt: robotKey.createdAt,
        lastUsedAt: robotKey.lastUsedAt,
        revokedAt: robotKey.revokedAt,
      })
      .from(robotKey)
      .where(eq(robotKey.userId, c.get("userId")))
      .orderBy(desc(robotKey.createdAt));
    return c.json({ keys });
  });

  /** Mints a key and returns it in full — the ONLY time it is ever visible.
   *  A first key also seeds the signup credit, so a new owner can teach
   *  immediately rather than hitting a 402 on their first sentence. */
  app.post("/keys", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const name =
      typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "My robot";

    const { raw, prefix, hash } = await mintKey();
    const id = crypto.randomUUID();
    await db.insert(robotKey).values({ id, userId, name, prefix, hash });

    const balance = await balanceFor(db, userId);
    if (balance.grantedMicros === 0) {
      await grant(db, userId, SIGNUP_GRANT_MICROS, "signup");
    }

    return c.json({ id, name, prefix, key: raw }, 201);
  });

  app.delete("/keys/:id", async (c) => {
    // Scoped by userId as well as id, so one owner can never revoke another's
    // key — an empty result is indistinguishable from "no such key", which is
    // exactly what we want to tell them.
    const result = await db
      .update(robotKey)
      .set({ revokedAt: new Date() })
      .where(and(eq(robotKey.id, c.req.param("id")), eq(robotKey.userId, c.get("userId"))))
      .returning();
    if (result.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  /** The robots this owner has paired — what the sidebar picker renders. */
  app.get("/robots", async (c) => {
    const robots = await db
      .select({
        id: robot.id,
        name: robot.name,
        platform: robot.platform,
        arms: robot.arms,
        address: robot.address,
        lastSeenAt: robot.lastSeenAt,
      })
      .from(robot)
      .where(eq(robot.userId, c.get("userId")))
      .orderBy(desc(robot.lastSeenAt));
    return c.json({ robots });
  });

  /** What is asking to be paired, for the approval screen. Returns the name
   *  the robot gave itself — "approve thor-rig", not "approve some device". */
  app.get("/device/pending", async (c) => {
    const userCode = c.req.query("user_code");
    if (!userCode) return c.json({ error: "user_code is required" }, 400);
    const [pending] = await db
      .select({ name: robot.name, platform: robot.platform, arms: robot.arms })
      .from(robot)
      .where(eq(robot.userCode, userCode))
      .limit(1);
    return c.json({ robot: pending ?? null });
  });

  /** The conversation, oldest first — what the app rehydrates on load. */
  app.get("/messages", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);
    const rows = await db
      .select({
        id: message.id,
        author: message.author,
        text: message.text,
        robotName: message.robotName,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(eq(message.userId, c.get("userId")))
      // seq, never createdAt: messages emitted inside the same millisecond
      // tie on a timestamp and come back in planner order.
      .orderBy(desc(message.seq))
      .limit(limit);
    // Newest-first in SQL so LIMIT keeps the RECENT tail, then flipped for
    // display — ordering ascending first would truncate to the oldest.
    return c.json({ messages: rows.reverse() });
  });

  app.post("/messages", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { id, author, text, robotName } = body ?? {};
    if (typeof id !== "string" || typeof text !== "string") {
      return c.json({ error: "id and text are required" }, 400);
    }
    if (author !== "you" && author !== "robot") {
      return c.json({ error: "author must be 'you' or 'robot'" }, 400);
    }
    await db
      .insert(message)
      .values({
        id,
        userId: c.get("userId"),
        author,
        text,
        robotName: typeof robotName === "string" ? robotName : null,
      })
      // Idempotent: a retried or replayed POST must not double the transcript.
      .onConflictDoNothing({ target: message.id });
    return c.json({ ok: true });
  });

  app.delete("/messages", async (c) => {
    await db.delete(message).where(eq(message.userId, c.get("userId")));
    return c.json({ ok: true });
  });

  app.get("/credits", async (c) => {
    const balance = await balanceFor(db, c.get("userId"));
    return c.json({
      ...balance,
      display: formatMicros(balance.balanceMicros),
      models: ALLOWED_MODELS,
    });
  });

  return app;
}
