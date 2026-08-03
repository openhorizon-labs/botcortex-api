/**
 * The metered inference proxy, independent of how the caller proved who they are.
 *
 * Two callers reach the same vendor call by different doors. A ROBOT presents a
 * `bx_live_` key (routes/robot.ts). The WEB APP presents its session cookie
 * (routes/account.ts) — because the browser sim runs the primitives and the
 * skill executor in the page, so the agent loop lives there too, and handing
 * browser JavaScript a durable robot key to hold would be a worse trade than
 * any convenience it bought.
 *
 * Everything that decides whether a call is forwarded at all — the model
 * allowlist, the provider match, the balance ceiling — is here, once. Two
 * copies of a billing gate is how one of them quietly stops charging.
 */
import type { Db } from "./db.js";
import { balanceFor, formatMicrosPrecise, recordUsage } from "./credits.js";
import { ALLOWED_MODELS, costMicros, priceFor, worstCaseMicros, type Provider } from "./pricing.js";
import { includeUsage, meteredStream } from "./streaming.js";

const DEFAULT_UPSTREAM: Record<Provider, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};

const ENV_KEY: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * Who is spending, and through what. `keyId` is null for the browser: there is
 * no key, and usage rows have always allowed that — the row still names the
 * user, which is what the balance is derived from.
 */
export interface Caller {
  userId: string;
  keyId: string | null;
}

/**
 * Read per-call, not at module load, so a test can stand a stub in front of a
 * vendor. That is the only way the Anthropic path gets exercised without a
 * live key — and the header forwarding it depends on breaks silently, since
 * every OpenAI test passes regardless.
 */
export function upstreamFor(provider: Provider): string {
  const override = process.env[`${provider.toUpperCase()}_UPSTREAM_URL`];
  return override || DEFAULT_UPSTREAM[provider];
}

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

export function upstreamHeaders(provider: Provider, incoming: Headers, secret: string): Headers {
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

function fail(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/**
 * Forward one call to a vendor and bill it, or explain why not.
 *
 * Returns a Response rather than taking a Hono context, so it does not care
 * which router mounted it — the guards below are about money and models, never
 * about routing.
 */
export async function meteredProxy(
  db: Db,
  caller: Caller,
  provider: Provider,
  request: Request,
): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.model !== "string") {
    return fail(400, "invalid_request_error", "Body must include a model.");
  }

  const price = priceFor(body.model);
  if (!price) {
    return fail(
      400,
      "invalid_request_error",
      `Model ${body.model} is not available on BotCortex credits. Allowed: ${ALLOWED_MODELS.join(", ")}`,
    );
  }
  if (price.provider !== provider) {
    return fail(
      400,
      "invalid_request_error",
      `Model ${body.model} is a ${price.provider} model; use that provider's endpoint.`,
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
  const balance = await balanceFor(db, caller.userId);
  const ceiling = worstCaseMicros(price, body.max_tokens);
  if (balance.balanceMicros < ceiling) {
    return fail(
      402,
      "insufficient_credit",
      balance.balanceMicros <= 0
        ? "This account is out of BotCortex credits. Taught skills keep running — only new teaching needs credit."
        : `Not enough BotCortex credit left to cover another ${body.model} call (${formatMicrosPrecise(balance.balanceMicros)} remaining, up to ${formatMicrosPrecise(ceiling)} needed). Taught skills keep running.`,
    );
  }

  const secret = process.env[ENV_KEY[provider]];
  if (!secret) {
    return fail(503, "api_error", `${ENV_KEY[provider]} is not configured on this server.`);
  }

  const streaming = Boolean(body.stream);
  const upstream = await fetch(upstreamFor(provider), {
    method: "POST",
    headers: upstreamHeaders(provider, request.headers, secret),
    // OpenAI omits usage from streams unless asked, so we always ask.
    body: JSON.stringify(streaming ? includeUsage(body, provider) : body),
  });

  if (streaming && upstream.ok && upstream.body) {
    // Mirror the bytes straight through and read the counts off them in
    // passing. onFinish also runs if the client hangs up early — tokens
    // spent before a tab closed were still spent.
    const metered = meteredStream(upstream.body, provider, (used) =>
      recordUsage(db, {
        userId: caller.userId,
        keyId: caller.keyId,
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
    userId: caller.userId,
    keyId: caller.keyId,
    model: body.model,
    inputTokens,
    outputTokens,
    costMicros: costMicros(price, inputTokens, outputTokens),
  });

  return Response.json(data);
}
