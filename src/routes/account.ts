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
import {
  SIGNUP_GRANT_MICROS,
  balanceFor,
  formatMicros,
  formatMicrosPrecise,
  formatMicrosUsed,
  grant,
} from "../credits.js";
import { meteredProxy } from "../inference.js";
import { mintKey } from "../keys.js";
import { ALLOWED_MODELS, DEFAULT_MODEL, catalogue } from "../pricing.js";
import { conversation, message, robot, robotKey } from "../app-schema.js";

type Env = { Variables: { userId: string } };

/** Roughly a long authored skill plus its arguments. */
const MAX_PAYLOAD_CHARS = 24_000;

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
        // Only real messages decide whether a task is worth listing. Tool
        // rows are machinery — a task showing nothing but the agent's
        // workings has nothing for an owner to recognise it by.
        messages: sql<number>`count(*) filter (where ${message.kind} = 'text')`,
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
        kind: message.kind,
        text: message.text,
        payload: message.payload,
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
    const { id, author, text, robotName, conversationId, kind, payload } = body ?? {};
    if (typeof id !== "string" || typeof text !== "string" || typeof conversationId !== "string") {
      return c.json({ error: "id, text and conversationId are required" }, 400);
    }
    if (author !== "you" && author !== "robot") {
      return c.json({ error: "author must be 'you' or 'robot'" }, 400);
    }
    const rowKind = kind === "tool" ? "tool" : "text";
    if (rowKind === "tool" && (!payload || typeof payload !== "object")) {
      return c.json({ error: "a tool row needs a payload" }, 400);
    }
    // A runaway tool result must not be able to bloat a row. The runtime
    // already previews results at 500 chars; this is the backstop for
    // arguments, where an authored skill legitimately runs to a few KB.
    if (rowKind === "tool" && JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) {
      return c.json({ error: "tool payload too large" }, 413);
    }

    const [owned] = await db
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.userId, userId)))
      .limit(1);
    if (!owned) return c.json({ error: "no such conversation" }, 404);

    const inserted = await db
      .insert(message)
      .values({
        id,
        conversationId,
        userId,
        author,
        kind: rowKind,
        text,
        payload: rowKind === "tool" ? payload : null,
        robotName: typeof robotName === "string" ? robotName : null,
      })
      // Idempotent: a retried or replayed POST must not double the transcript.
      .onConflictDoNothing({ target: message.id })
      .returning();

    await db
      .update(conversation)
      .set({ updatedAt: new Date() })
      .where(eq(conversation.id, conversationId));

    // Title = the first thing the OWNER typed, verbatim. Claimed atomically.
    //
    // Computing it from the row read above and writing it back looks
    // equivalent and is not: a user message and the robot's reply post
    // concurrently, both read title=null, and whichever UPDATE lands last
    // wins — so the robot's reply blanked the title the user's message had
    // just set. `where title is null` lets exactly one writer take it.
    //
    // A model used to rewrite it into something tidier, and that was a
    // mistake. Typing "wave the left arm" produced a sidebar row reading "move
    // left arm up and down" — a paraphrase the owner never wrote, which does
    // not match what they are looking for and which COLLIDED with an existing
    // row that had been paraphrased the same way. A task list is for
    // recognising your own work; the words you chose are what you will scan
    // for. It also cost a model call per conversation, on us.
    if (author === "you" && rowKind === "text") {
      await db
        .update(conversation)
        .set({ title: text.slice(0, 60).trim() })
        .where(and(eq(conversation.id, conversationId), isNull(conversation.title)));
    }

    // `stored` distinguishes "written" from "already had that id". Replying
    // ok:true either way hid a client bug for an hour — every POST looked
    // accepted while most were quietly doing nothing.
    return c.json({ ok: true, stored: inserted.length > 0 });
  });

  /**
   * Inference for the BROWSER sim, billed to the signed-in account.
   *
   * Same guards, same meter, same prices as the robot's endpoint — it is
   * literally the same function (inference.ts). The only difference is the
   * door: a session cookie rather than a `bx_live_` key, because the agent
   * loop for the browser sim runs in the page, and a durable key held in
   * browser JavaScript would be a worse trade than any convenience it bought.
   *
   * `keyId` is null, which usage rows have always permitted. The row still
   * names the user, and the balance is derived from the user.
   */
  app.post("/inference/chat", (c) =>
    meteredProxy(db, { userId: c.get("userId"), keyId: null }, "openai", c.req.raw),
  );

  app.post("/inference/messages", (c) =>
    meteredProxy(db, { userId: c.get("userId"), keyId: null }, "anthropic", c.req.raw),
  );

  /** The model picker's data — ids, labels, real per-token prices, and
   *  whether this balance can cover a teach on each. Served from the same
   *  table the proxy bills from, so the price shown is the price charged. */
  app.get("/models", async (c) => {
    const balance = await balanceFor(db, c.get("userId"));
    return c.json({
      models: catalogue(balance.balanceMicros),
      default: DEFAULT_MODEL,
      balanceMicros: balance.balanceMicros,
    });
  });

  app.get("/credits", async (c) => {
    const balance = await balanceFor(db, c.get("userId"));
    return c.json({
      ...balance,
      display: formatMicros(balance.balanceMicros),
      // Precise: two decimals would report a real afternoon of
      // teaching as "$0.00".
      spentDisplay: formatMicrosPrecise(balance.spentMicros),
      // The sidebar reads "used / total", so both halves are formatted here
      // rather than assembled in the client — how money is written is this
      // service's business, and two clients would drift apart.
      usedDisplay: formatMicrosUsed(balance.spentMicros),
      grantedDisplay: formatMicros(balance.grantedMicros),
      models: ALLOWED_MODELS,
    });
  });

  return app;
}
