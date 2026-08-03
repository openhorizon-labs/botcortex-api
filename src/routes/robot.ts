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
 */
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import type { Db } from "../db.js";
import { balanceFor, formatMicros, recordUsage } from "../credits.js";
import { keyFromRequest, resolveKey, sha256, type ResolvedKey } from "../keys.js";
import {
  ALLOWED_MODELS,
  costMicros,
  priceFor,
  worstCaseMicros,
  type Provider,
} from "../pricing.js";
import { includeUsage, meteredStream } from "../streaming.js";
import { robot, skill } from "../app-schema.js";
import { user } from "../auth-schema.js";

const DEFAULT_UPSTREAM: Record<Provider, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};

/**
 * Read per-call, not at module load, so a test can stand a stub in front of a
 * vendor. That is the only way the Anthropic path gets exercised without a
 * live key — and the header forwarding it depends on breaks silently, since
 * every OpenAI test passes regardless.
 */
function upstreamFor(provider: Provider): string {
  const override = process.env[`${provider.toUpperCase()}_UPSTREAM_URL`];
  return override || DEFAULT_UPSTREAM[provider];
}

const ENV_KEY: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

type Env = { Variables: { key: ResolvedKey } };

/** Token counts, normalised across the two response shapes.
 *  Anthropic reports cached tokens separately; we fold them into input at
 *  full rate — a small overcharge on cache hits, and the honest direction to
 *  err while this is a preview. Revisit if prompt caching gets heavy use. */
export function tokensFrom(data: any, provider: Provider) {
  const u = data?.usage ?? {};
  if (provider === "openai") {
    return {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
    };
  }
  return {
    inputTokens:
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
}

export function upstreamHeaders(
  provider: Provider,
  incoming: Headers,
  secret: string,
): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (provider === "openai") {
    headers.set("authorization", `Bearer ${secret}`);
    return headers;
  }
  headers.set("x-api-key", secret);
  // The tool runner negotiates features through these; constructing a clean
  // request without them breaks the Anthropic path in ways the OpenAI path
  // never surfaces.
  headers.set("anthropic-version", incoming.get("anthropic-version") ?? "2023-06-01");
  const beta = incoming.get("anthropic-beta");
  if (beta) headers.set("anthropic-beta", beta);
  return headers;
}

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

  async function proxy(c: any, provider: Provider) {
    const key = c.get("key") as ResolvedKey;

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.model !== "string") {
      return c.json(
        { error: { type: "invalid_request_error", message: "Body must include a model." } },
        400,
      );
    }
    const price = priceFor(body.model);
    if (!price) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: `Model ${body.model} is not available on BotCortex credits. Allowed: ${ALLOWED_MODELS.join(", ")}`,
          },
        },
        400,
      );
    }
    if (price.provider !== provider) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: `Model ${body.model} is a ${price.provider} model; use that provider's endpoint.`,
          },
        },
        400,
      );
    }

    // The owner's balance is judged before our own configuration: an account
    // with no credit gets the same actionable 402 whether or not the server
    // happens to hold a vendor key.
    //
    // Judged against what this call could cost at WORST, not against zero. A
    // balance-above-zero check let an account holding a hundredth of a cent
    // start a call that finished dollars in the red, because the debit only
    // happens once the response arrives.
    const balance = await balanceFor(db, key.userId);
    const ceiling = worstCaseMicros(price, body.max_tokens);
    if (balance.balanceMicros < ceiling) {
      return c.json(
        {
          error: {
            type: "insufficient_credit",
            message:
              balance.balanceMicros <= 0
                ? "This account is out of BotCortex credits. Taught skills keep running — only new teaching needs credit."
                : `Not enough BotCortex credit left to cover another ${body.model} call (${formatMicros(balance.balanceMicros)} remaining, up to ${formatMicros(ceiling)} needed). Taught skills keep running.`,
          },
        },
        402,
      );
    }

    const secret = process.env[ENV_KEY[provider]];
    if (!secret) {
      return c.json(
        {
          error: {
            type: "api_error",
            message: `${ENV_KEY[provider]} is not configured on this server.`,
          },
        },
        503,
      );
    }

    const streaming = Boolean(body.stream);
    const upstream = await fetch(upstreamFor(provider), {
      method: "POST",
      headers: upstreamHeaders(provider, c.req.raw.headers, secret),
      // OpenAI omits usage from streams unless asked, so we always ask.
      body: JSON.stringify(streaming ? includeUsage(body, provider) : body),
    });

    if (streaming && upstream.ok && upstream.body) {
      // Mirror the bytes straight through and read the counts off them in
      // passing. onFinish also runs if the client hangs up early — tokens
      // spent before a tab closed were still spent.
      const metered = meteredStream(upstream.body, provider, (used) =>
        recordUsage(db, {
          userId: key.userId,
          keyId: key.id,
          model: body.model,
          inputTokens: used.inputTokens,
          outputTokens: used.outputTokens,
          costMicros: costMicros(price, used.inputTokens, used.outputTokens),
        }),
      );
      return new Response(metered, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      // Pass the vendor's own error through untouched — the SDK on the robot
      // knows how to read it, and masking it would make debugging guesswork.
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    }

    const data = JSON.parse(text);
    const { inputTokens, outputTokens } = tokensFrom(data, provider);
    await recordUsage(db, {
      userId: key.userId,
      keyId: key.id,
      model: body.model,
      inputTokens,
      outputTokens,
      costMicros: costMicros(price, inputTokens, outputTokens),
    });

    return c.json(data);
  }

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
        spentDisplay: formatMicros(balance.spentMicros),
      },
      models: ALLOWED_MODELS,
    });
  });

  return app;
}
