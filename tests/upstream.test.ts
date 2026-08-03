/**
 * The proxy against a STUB vendor — no key, no network, runs in CI.
 *
 * The OpenAI branch is driven through the real route. The Anthropic branch is
 * covered at the function level instead: no Claude model is priced any more
 * (the offering is GPT-only), so /v1/messages cannot be reached end-to-end.
 * The header forwarding and token folding it depends on are the parts that
 * break silently, so they are tested directly rather than left to rot until
 * someone re-adds Claude.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { usage } from "../src/app-schema.js";
import { tokensFrom, upstreamHeaders } from "../src/routes/robot.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let key: string;
let userId: string;
let seen: { headers: Headers; body: any } | null = null;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  const cookie = await signUp(app, "upstream@example.com");
  const created = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "stub robot" }),
  });
  key = (await created.json()).key;
  userId = (
    await (await app.request("/api/me", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()
  ).user.id;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen = { headers: req.headers, body: await req.json() };
      return Response.json({
        id: "chatcmpl_stub",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      });
    },
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${server.port}`;
  process.env.OPENAI_API_KEY = "sk-server-side-secret";
});

afterAll(() => {
  server?.stop(true);
  delete process.env.OPENAI_UPSTREAM_URL;
  delete process.env.OPENAI_API_KEY;
});

const call = () =>
  app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [] }),
  });

test("the call is forwarded and the vendor's body returned", async () => {
  const res = await call();
  expect(res.status).toBe(200);
  expect((await res.json()).id).toBe("chatcmpl_stub");
});

test("the robot's key never reaches the vendor — ours does", async () => {
  await call();
  expect(seen!.headers.get("authorization")).toBe("Bearer sk-server-side-secret");
  expect(JSON.stringify(seen!.headers.toJSON())).not.toContain("bx_live_");
});

test("usage is metered at the table rate", async () => {
  const before = await db.select().from(usage).where(eq(usage.userId, userId));
  await call();
  const after = await db.select().from(usage).where(eq(usage.userId, userId));
  expect(after.length).toBe(before.length + 1);

  const row = after[after.length - 1];
  expect(row.model).toBe("gpt-5-nano");
  expect(row.inputTokens).toBe(1000);
  expect(row.outputTokens).toBe(500);
  // gpt-5-nano: $0.05/Mtok in, $0.40/Mtok out.
  expect(row.costMicros).toBe(Math.ceil(1000 * 0.05 + 500 * 0.4));
});

test("a vendor error passes through untouched, and is not billed", async () => {
  server.stop(true);
  const failing = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: { type: "overloaded_error" } }, { status: 529 }),
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${failing.port}`;

  const before = await db.select().from(usage).where(eq(usage.userId, userId));
  const res = await call();
  expect(res.status).toBe(529);
  expect((await res.json()).error.type).toBe("overloaded_error");
  expect((await db.select().from(usage).where(eq(usage.userId, userId))).length).toBe(
    before.length,
  );
  failing.stop(true);
});

// --- Anthropic: dormant route, still covered ------------------------------

test("anthropic headers carry the features the tool runner negotiates", () => {
  const incoming = new Headers({
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "tools-2024-04-04",
  });
  const out = upstreamHeaders("anthropic", incoming, "sk-ant-ours");
  expect(out.get("x-api-key")).toBe("sk-ant-ours");
  expect(out.get("anthropic-version")).toBe("2023-06-01");
  expect(out.get("anthropic-beta")).toBe("tools-2024-04-04");
  // Never the OpenAI shape.
  expect(out.get("authorization")).toBeNull();
});

test("a missing anthropic-version is defaulted rather than dropped", () => {
  const out = upstreamHeaders("anthropic", new Headers(), "sk-ant-ours");
  expect(out.get("anthropic-version")).toBe("2023-06-01");
});

test("anthropic cache tokens are folded into metered input, not lost", () => {
  const counted = tokensFrom(
    {
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    },
    "anthropic",
  );
  expect(counted).toEqual({ inputTokens: 1500, outputTokens: 500 });
});
