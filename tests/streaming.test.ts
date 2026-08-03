/**
 * Streamed responses, metered on the way past.
 *
 * Streaming used to be a hard 400: usage only arrives at the END of an SSE
 * stream, so forwarding blind would have been free inference. These drive real
 * SSE bytes — split across chunk boundaries the way TCP actually delivers them
 * — and assert a usage row lands with the right numbers.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { usage } from "../src/app-schema.js";
import { includeUsage, meteredStream, usageFromEvent } from "../src/streaming.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let key: string;
let userId: string;
let server: ReturnType<typeof Bun.serve>;
let lastRequestBody: any = null;

/** An OpenAI-shaped stream, deliberately split mid-event. */
const OPENAI_FRAMES = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
  '\ndata: {"choices":[],"usa',
  'ge":{"prompt_tokens":1200,"completion_tokens":340}}\n\n',
  "data: [DONE]\n\n",
];

beforeAll(async () => {
  ({ app, db } = await makeApp());
  const cookie = await signUp(app, "stream@example.com");
  const created = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "streamer" }),
  });
  key = (await created.json()).key;
  userId = (
    await (await app.request("/api/me", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()
  ).user.id;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastRequestBody = await req.json();
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of OPENAI_FRAMES) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${server.port}`;
  process.env.OPENAI_API_KEY = "sk-server-side";
});

afterAll(() => {
  server?.stop(true);
  delete process.env.OPENAI_UPSTREAM_URL;
  delete process.env.OPENAI_API_KEY;
});

test("a streamed call reaches the client intact AND lands a usage row", async () => {
  const before = await db.select().from(usage).where(eq(usage.userId, userId));

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [], stream: true }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  // The client gets every byte, unaltered.
  const text = await res.text();
  expect(text).toBe(OPENAI_FRAMES.join(""));
  expect(text).toContain("[DONE]");

  const after = await db.select().from(usage).where(eq(usage.userId, userId));
  expect(after.length).toBe(before.length + 1);
  const row = after[after.length - 1];
  expect(row.inputTokens).toBe(1200);
  expect(row.outputTokens).toBe(340);
  // gpt-5-nano: $0.05/Mtok in, $0.40/Mtok out.
  expect(row.costMicros).toBe(Math.ceil(1200 * 0.05 + 340 * 0.4));
});

test("we ask OpenAI for usage, because it omits it from streams otherwise", async () => {
  await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [], stream: true }),
  });
  expect(lastRequestBody.stream_options.include_usage).toBe(true);
});

test("includeUsage preserves options the caller already set", () => {
  const out = includeUsage(
    { model: "gpt-5-nano", stream_options: { something_else: 1 } },
    "openai",
  ) as any;
  expect(out.stream_options).toEqual({ something_else: 1, include_usage: true });
  // Anthropic reports usage unasked; leave its body alone.
  const untouched = { model: "claude-opus-5" };
  expect(includeUsage(untouched, "anthropic")).toBe(untouched);
});

test("Anthropic's cumulative output is taken at its max, not summed", async () => {
  // message_delta reports a RUNNING total; adding deltas would bill 10+30+90.
  const frames = [
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":500,"cache_read_input_tokens":100}}}\n\n',
    'event: message_delta\ndata: {"usage":{"output_tokens":10}}\n\n',
    'event: message_delta\ndata: {"usage":{"output_tokens":30}}\n\n',
    'event: message_delta\ndata: {"usage":{"output_tokens":90}}\n\n',
  ];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });

  // An array, not a nullable let: it dodges TS's closure narrowing AND
  // proves onFinish fires exactly once rather than per event.
  const counted: { inputTokens: number; outputTokens: number }[] = [];
  const metered = meteredStream(source, "anthropic", (u) => {
    counted.push(u);
  });
  await new Response(metered).text();

  expect(counted).toEqual([{ inputTokens: 600, outputTokens: 90 }]);
});

test("a client hanging up mid-stream is still billed for what it used", async () => {
  const frames = [
    'data: {"choices":[],"usage":{"prompt_tokens":700,"completion_tokens":50}}\n\n',
    'data: {"choices":[{"delta":{"content":"more"}}]}\n\n',
  ];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });

  const counted: { inputTokens: number; outputTokens: number }[] = [];
  const metered = meteredStream(source, "openai", (u) => {
    counted.push(u);
  });

  const reader = metered.getReader();
  await reader.read(); // take one chunk, then walk away
  await reader.cancel("client closed the tab");

  expect(counted).toEqual([{ inputTokens: 700, outputTokens: 50 }]);
});

test("junk frames are skipped rather than throwing", () => {
  expect(usageFromEvent("event: ping", "openai")).toBeNull();
  expect(usageFromEvent("data: [DONE]", "openai")).toBeNull();
  expect(usageFromEvent("data: {not json", "openai")).toBeNull();
  expect(usageFromEvent('data: {"choices":[]}', "openai")).toBeNull();
});
