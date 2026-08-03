/**
 * The proxy against a STUB vendor.
 *
 * The Anthropic branch has never run end-to-end: every existing test drives
 * the OpenAI path, which passes whether or not `anthropic-version` and
 * `anthropic-beta` are forwarded — and the tool runner negotiates through
 * exactly those. A stub upstream exercises it with no key and no network,
 * which a live key could never do in CI.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { usage } from "../src/app-schema.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let key: string;
let userId: string;

/** What the stub saw, so we can assert on what we sent it. */
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
  userId = (await (await app.request("/api/me", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()).user.id;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen = { headers: req.headers, body: await req.json() };
      return Response.json({
        id: "msg_stub",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      });
    },
  });
  process.env.ANTHROPIC_UPSTREAM_URL = `http://localhost:${server.port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-server-side-secret";
});

afterAll(() => {
  server?.stop(true);
  delete process.env.ANTHROPIC_UPSTREAM_URL;
  delete process.env.ANTHROPIC_API_KEY;
});

const callAnthropic = (headers: Record<string, string> = {}) =>
  app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify({ model: "claude-opus-5", max_tokens: 1024, messages: [] }),
  });

test("the Anthropic path forwards, meters, and returns the vendor's body", async () => {
  const res = await callAnthropic({
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "tools-2024-04-04",
  });
  expect(res.status).toBe(200);
  expect((await res.json()).id).toBe("msg_stub");

  // The features tool_runner negotiates must survive the hop.
  expect(seen!.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(seen!.headers.get("anthropic-beta")).toBe("tools-2024-04-04");
});

test("the robot's key never reaches the vendor — ours does", async () => {
  await callAnthropic();
  expect(seen!.headers.get("x-api-key")).toBe("sk-ant-server-side-secret");
  expect(seen!.headers.get("x-api-key")).not.toBe(key);
  expect(JSON.stringify(seen!.headers.toJSON())).not.toContain("bx_live_");
});

test("anthropic-version is defaulted rather than dropped", async () => {
  await callAnthropic();
  // The SDK always sends one, but a bare curl must not produce a 400 upstream.
  expect(seen!.headers.get("anthropic-version")).toBe("2023-06-01");
});

test("cache tokens are folded into the metered input, not lost", async () => {
  const before = await db.select().from(usage).where(eq(usage.userId, userId));
  await callAnthropic();
  const after = await db.select().from(usage).where(eq(usage.userId, userId));
  expect(after.length).toBe(before.length + 1);

  const row = after[after.length - 1];
  expect(row.model).toBe("claude-opus-5");
  // 1000 plain + 200 cache-creation + 300 cache-read.
  expect(row.inputTokens).toBe(1500);
  expect(row.outputTokens).toBe(500);
  // claude-opus-5: $5/Mtok in, $25/Mtok out.
  expect(row.costMicros).toBe(1500 * 5 + 500 * 25);
});

test("a vendor error passes through untouched, and is not billed", async () => {
  server.stop(true);
  const failing = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: { type: "overloaded_error" } }, { status: 529 }),
  });
  process.env.ANTHROPIC_UPSTREAM_URL = `http://localhost:${failing.port}`;

  const before = await db.select().from(usage).where(eq(usage.userId, userId));
  const res = await callAnthropic();
  expect(res.status).toBe(529);
  expect((await res.json()).error.type).toBe("overloaded_error");

  const after = await db.select().from(usage).where(eq(usage.userId, userId));
  expect(after.length).toBe(before.length);
  failing.stop(true);
});
