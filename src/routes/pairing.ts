/**
 * Pairing — the two steps of the device flow that Better Auth doesn't own.
 *
 * Better Auth's deviceAuthorization plugin handles the codes, the approval,
 * and the token. What it can't know is WHAT is asking to be paired, or that
 * we want a long-lived robot key rather than a session at the end of it.
 *
 *   POST /v1/device/describe   the robot says what it is, before approval
 *   POST /v1/keys/exchange     device session -> a durable bx_live_ key
 *
 * Both live under /v1 because a robot calls them, but neither can use the
 * robot-key guard: at this point in the flow the robot has no key yet. They
 * are mounted BEFORE robotRoutes so its guard never sees them.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";

import type { Db } from "../db.js";
import type { AuthLike } from "../hono.js";
import { SIGNUP_GRANT_MICROS, balanceFor, grant } from "../credits.js";
import { mintKey, sha256 } from "../keys.js";
import { deviceCode } from "../auth-schema.js";
import { robot, robotKey } from "../app-schema.js";

/** A pending, unexpired pairing for this exact device code. */
async function pendingFor(db: Db, code: string) {
  const [row] = await db
    .select({ userCode: deviceCode.userCode })
    .from(deviceCode)
    .where(
      and(
        eq(deviceCode.deviceCode, code),
        eq(deviceCode.status, "pending"),
        gt(deviceCode.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function pairingRoutes(auth: AuthLike, db: Db) {
  const app = new Hono();

  /**
   * The robot introduces itself so the approval screen can name it.
   *
   * Authenticated by the SECRET device_code, never the short user_code: if a
   * guessable code let anyone attach a label to a pending pairing, an attacker
   * could make their own device read as "thor-rig" on the approve screen, and
   * naming the device is the entire point of asking a human to confirm.
   */
  app.post("/device/describe", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { device_code: code, name, platform, arms } = body ?? {};
    if (typeof code !== "string" || typeof name !== "string" || typeof platform !== "string") {
      return c.json({ error: "device_code, name and platform are required" }, 400);
    }

    const pending = await pendingFor(db, code);
    if (!pending) return c.json({ error: "unknown or expired device code" }, 404);

    // Sweep pairings that were started and never approved, so the sidebar's
    // robot list never renders the debris of abandoned attempts.
    await db
      .delete(robot)
      .where(
        and(
          isNull(robot.userId),
          sql`${robot.userCode} NOT IN (SELECT ${deviceCode.userCode} FROM ${deviceCode} WHERE ${deviceCode.expiresAt} > now())`,
        ),
      );

    const [existing] = await db
      .select({ id: robot.id })
      .from(robot)
      .where(eq(robot.userCode, pending.userCode))
      .limit(1);

    const fields = {
      name,
      platform,
      arms: Number.isFinite(arms) ? Number(arms) : 2,
      deviceCodeHash: await sha256(code),
    };
    if (existing) {
      await db.update(robot).set(fields).where(eq(robot.id, existing.id));
    } else {
      await db
        .insert(robot)
        .values({ id: crypto.randomUUID(), userCode: pending.userCode, ...fields });
    }

    return c.json({ ok: true });
  });

  /**
   * Trades the short-lived session from /device/token for the durable key the
   * robot actually runs on. Authenticated by that session as a bearer token —
   * which is why the bearer plugin is not optional.
   */
  app.post("/keys/exchange", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const userId = (session.user as { id: string }).id;

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

  return app;
}
