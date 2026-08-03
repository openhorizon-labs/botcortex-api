/**
 * Routes the WEB APP calls, authenticated by the Better Auth session cookie.
 *
 * These reach us through the Next rewrite in the web repo, which is what
 * keeps the cookie first-party — fetching this origin directly from the
 * browser sends no cookie and lands on a 401.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";

import type { Db } from "../db.js";
import type { AuthLike } from "../hono.js";
import { SIGNUP_GRANT_MICROS, balanceFor, formatMicros, grant } from "../credits.js";
import { mintKey } from "../keys.js";
import { ALLOWED_MODELS } from "../pricing.js";
import { conversation, message, robot, robotKey } from "../app-schema.js";

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

  /** The owner's threads, most recently active first.
   *  Empty ones are omitted — an untouched "New task" should not leave a
   *  blank row behind in the sidebar. */
  app.get("/conversations", async (c) => {
    const rows = await db
      .select({
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        messages: sql<number>`count(${message.id})`,
      })
      .from(conversation)
      .leftJoin(message, eq(message.conversationId, conversation.id))
      .where(eq(conversation.userId, c.get("userId")))
      .groupBy(conversation.id)
      .orderBy(desc(conversation.updatedAt));
    return c.json({
      conversations: rows
        .filter((r) => Number(r.messages) > 0)
        .map(({ messages: count, ...rest }) => ({ ...rest, messages: Number(count) })),
    });
  });

  app.post("/conversations", async (c) => {
    const id = crypto.randomUUID();
    await db.insert(conversation).values({ id, userId: c.get("userId") });
    return c.json({ id }, 201);
  });

  app.delete("/conversations/:id", async (c) => {
    // Scoped by owner: an id alone must never reach someone else's thread.
    const gone = await db
      .delete(conversation)
      .where(
        and(eq(conversation.id, c.req.param("id")), eq(conversation.userId, c.get("userId"))),
      )
      .returning();
    if (gone.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  /** One thread's messages, oldest first — what the app rehydrates on load. */
  app.get("/messages", async (c) => {
    const conversationId = c.req.query("conversation");
    if (!conversationId) return c.json({ error: "conversation is required" }, 400);

    // Ownership is checked on the CONVERSATION, so a guessed id returns
    // nothing rather than someone else's transcript.
    const [owned] = await db
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.userId, c.get("userId"))))
      .limit(1);
    if (!owned) return c.json({ messages: [] });

    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);
    const rows = await db
      .select({
        id: message.id,
        author: message.author,
        text: message.text,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(eq(message.conversationId, conversationId))
      // seq, never createdAt: messages emitted inside the same millisecond
      // tie on a timestamp and come back in planner order.
      .orderBy(desc(message.seq))
      .limit(limit);
    // Newest-first in SQL so LIMIT keeps the RECENT tail, then flipped for
    // display — ordering ascending first would truncate to the oldest.
    return c.json({ messages: rows.reverse() });
  });

  app.post("/messages", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null);
    const { id, author, text, robotName, conversationId } = body ?? {};
    if (typeof id !== "string" || typeof text !== "string" || typeof conversationId !== "string") {
      return c.json({ error: "id, text and conversationId are required" }, 400);
    }
    if (author !== "you" && author !== "robot") {
      return c.json({ error: "author must be 'you' or 'robot'" }, 400);
    }

    const [owned] = await db
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.userId, userId)))
      .limit(1);
    if (!owned) return c.json({ error: "no such conversation" }, 404);

    await db
      .insert(message)
      .values({
        id,
        conversationId,
        userId,
        author,
        text,
        robotName: typeof robotName === "string" ? robotName : null,
      })
      // Idempotent: a retried or replayed POST must not double the transcript.
      .onConflictDoNothing({ target: message.id });

    await db
      .update(conversation)
      .set({ updatedAt: new Date() })
      .where(eq(conversation.id, conversationId));

    // Title from the first thing the OWNER typed, claimed atomically.
    //
    // Computing it from the row read above and writing it back looks
    // equivalent and is not: a user message and the robot's reply post
    // concurrently, both read title=null, and whichever UPDATE lands last
    // wins — so the robot's reply blanked the title the user's message had
    // just set. `where title is null` lets exactly one writer take it.
    if (author === "you") {
      await db
        .update(conversation)
        .set({ title: text.slice(0, 40) })
        .where(and(eq(conversation.id, conversationId), isNull(conversation.title)));
    }

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
