/**
 * Routes a ROBOT calls, authenticated by a robot key (never a session).
 *
 * The inference routes are deliberately shaped as drop-in replacements for
 * the vendors' own endpoints, so the runtime enables them by swapping one
 * base_url — the agent, its tools, and its loop stay exactly where they are,
 * on the robot. We become the billing seam, not a step in the agent loop.
 *
 *   POST /v1/chat/completions   OpenAI-shaped   (client base_url = <api>/v1)
 *   POST /v1/messages           Anthropic-shaped (client base_url = <api>)
 *   POST /v1/skills             skill sync
 *   POST /v1/robots/register    a paired robot announcing itself
 *   GET  /v1/me                 who this key belongs to + remaining credit
 *
 * Streamed responses are forwarded and metered on the way past — see
 * streaming.ts. They used to be refused outright, because usage only arrives
 * at the very end of an SSE stream and forwarding blind would have been free.
 *
 * The forwarding and billing themselves live in inference.ts, shared with the
 * cookie-authenticated route the browser sim uses. This file is now only about
 * proving a ROBOT is calling.
 */
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import type { Db } from "../db.js";
import {
  balanceFor,
  formatMicros,
  formatMicrosPrecise,
  formatMicrosUsed,
} from "../credits.js";
import { meteredProxy } from "../inference.js";
import { keyFromRequest, resolveKey, sha256, type ResolvedKey } from "../keys.js";
import { ALLOWED_MODELS, type Provider } from "../pricing.js";
import { robot, skill } from "../app-schema.js";
import { user } from "../auth-schema.js";

type Env = { Variables: { key: ResolvedKey } };

export function robotRoutes(db: Db) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const raw = keyFromRequest(c.req.raw.headers);
    if (!raw) {
      return c.json(
        { error: { type: "authentication_error", message: "Missing robot key." } },
        401,
      );
    }
    const resolved = await resolveKey(db, raw);
    if (!resolved) {
      return c.json(
        {
          error: {
            type: "authentication_error",
            message: "Unknown or revoked robot key. Mint a new one in the BotCortex app.",
          },
        },
        401,
      );
    }
    c.set("key", resolved);
    await next();
  });

  /** Both inference routes are the same call with a different shape. Who is
   *  spending comes from the key the middleware above resolved. */
  const proxy = (c: any, provider: Provider) =>
    meteredProxy(db, { userId: c.get("key").userId, keyId: c.get("key").id }, provider, c.req.raw);

  app.post("/chat/completions", (c) => proxy(c, "openai"));
  app.post("/messages", (c) => proxy(c, "anthropic"));

  /** Skill sync. The robot keeps the original and runs from disk; this copy
   *  feeds the registry. Best-effort by contract — the runtime never lets a
   *  failure here break a teach. */
  app.post("/skills", async (c) => {
    const key = c.get("key");
    const body = await c.req.json().catch(() => null);
    const { name, description, code, platform } = body ?? {};
    if (
      typeof name !== "string" ||
      typeof code !== "string" ||
      typeof description !== "string"
    ) {
      return c.json({ error: "name, description and code are required" }, 400);
    }

    const now = new Date();
    await db
      .insert(skill)
      .values({
        id: crypto.randomUUID(),
        userId: key.userId,
        name,
        description,
        code,
        platform: typeof platform === "string" ? platform : "unknown",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [skill.userId, skill.name],
        set: { description, code, updatedAt: now },
      });

    return c.json({ ok: true, name });
  });

  /**
   * The robot claims the row it described during pairing, or announces itself
   * on later boots. Address is the LAN WebSocket the web app dials — which is
   * what lets the app list robots instead of asking the owner to type a host.
   *
   * Same-LAN only by design: reaching a robot from another network is the
   * relay's job, and pairing does not pretend to solve it.
   */
  app.post("/robots/register", async (c) => {
    const key = c.get("key");
    const body = await c.req.json().catch(() => null);
    const { device_code: code, name, platform, arms, address } = body ?? {};
    if (typeof name !== "string" || typeof platform !== "string") {
      return c.json({ error: "name and platform are required" }, 400);
    }

    const fields = {
      userId: key.userId,
      keyId: key.id,
      name,
      platform,
      arms: Number.isFinite(arms) ? Number(arms) : 2,
      address: typeof address === "string" ? address : null,
      lastSeenAt: new Date(),
      userCode: null,
    };

    // Claim the row described during pairing, if this registration is the tail
    // of a fresh pair; otherwise fall through to upsert by (owner, name).
    //
    // Matched on OUR hash of the device code, not the device_code table: Better
    // Auth deletes that row the instant the token is redeemed, so by the time a
    // robot registers there is nothing left to join against.
    if (typeof code === "string") {
      const claimed = await db
        .update(robot)
        .set({ ...fields, deviceCodeHash: null })
        .where(and(eq(robot.deviceCodeHash, await sha256(code)), isNull(robot.userId)))
        .returning();
      if (claimed.length > 0) return c.json({ ok: true, id: claimed[0].id });
    }

    const [row] = await db
      .insert(robot)
      .values({ id: crypto.randomUUID(), ...fields })
      .onConflictDoUpdate({
        target: [robot.userId, robot.name],
        set: { keyId: fields.keyId, platform, arms: fields.arms, address: fields.address, lastSeenAt: fields.lastSeenAt },
      })
      .returning();

    return c.json({ ok: true, id: row?.id });
  });

  app.get("/me", async (c) => {
    const key = c.get("key");
    const [owner] = await db
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, key.userId))
      .limit(1);
    const balance = await balanceFor(db, key.userId);
    return c.json({
      user: owner ?? null,
      credit: {
        ...balance,
        display: formatMicros(balance.balanceMicros),
        // Precise: two decimals would report a real afternoon of teaching
        // as "$0.00".
        spentDisplay: formatMicrosPrecise(balance.spentMicros),
        usedDisplay: formatMicrosUsed(balance.spentMicros),
        grantedDisplay: formatMicros(balance.grantedMicros),
      },
      models: ALLOWED_MODELS,
    });
  });

  return app;
}
