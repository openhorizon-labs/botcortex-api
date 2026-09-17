/**
 * Bring your own key, held by the backend.
 *
 * Three promises, each of which has a way to be quietly false: the key never
 * comes back out (not in a response, not readable in the database); a call made
 * with it is never gated or charged by our credit; and an Anthropic key behind
 * the chat-completions door is really served by the Messages API, thinking
 * blocks and all.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { modelKey, usage } from "../src/app-schema.js";
import { ANTHROPIC_MODEL, toAnthropic } from "../src/anthropic-chat.js";
import { providerOf, seal, unseal } from "../src/byok.js";

const OPENAI_KEY = "sk-proj-owner0000000000000000aaaa";
const ANTHROPIC_KEY = "sk-ant-api03-owner00000000000000bbbb";
const REVOKED = "sk-proj-revoked000000000000000000";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let cookie: string;
let userId: string;
let openai: ReturnType<typeof Bun.serve>;
let anthropic: ReturnType<typeof Bun.serve>;
const seen: { auth: string | null; body: any }[] = [];
const claude: { key: string | null; beta: string | null; body: any }[] = [];

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
  ({ app, db } = await makeApp());
  cookie = await signUp(app, "byok@example.com");
  userId = (await (await app.request("/api/me", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()).user.id;

  openai = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization");
      if (new URL(req.url).pathname.endsWith("/models")) {
        return auth === `Bearer ${REVOKED}` ? Response.json({ error: { message: "bad key" } }, { status: 401 }) : Response.json({ data: [] });
      }
      const body = await req.json();
      seen.push({ auth, body });
      return Response.json({ id: "chatcmpl_own", model: body.model, choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 900, completion_tokens: 100 } });
    },
  });
  anthropic = Bun.serve({
    port: 0,
    async fetch(req) {
      const key = req.headers.get("x-api-key");
      if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [], has_more: false, first_id: null, last_id: null });
      const body = await req.json();
      claude.push({ key, beta: req.headers.get("anthropic-beta"), body });
      return Response.json({
        id: "msg_own", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", stop_sequence: null,
        content: [
          { type: "thinking", thinking: "", signature: "sig-abc" },
          { type: "text", text: "Looking at the table." },
          { type: "tool_use", id: "toolu_1", name: "describe_scene", input: {} },
        ],
        usage: { input_tokens: 1200, output_tokens: 80 },
      });
    },
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${openai.port}/chat/completions`;
  process.env.ANTHROPIC_UPSTREAM_URL = `http://localhost:${anthropic.port}/v1/messages`;
  process.env.OPENAI_API_KEY = "sk-the-servers-own-key";
});

afterAll(() => {
  openai?.stop(true);
  anthropic?.stop(true);
  for (const name of ["OPENAI_UPSTREAM_URL", "ANTHROPIC_UPSTREAM_URL", "OPENAI_API_KEY"]) delete process.env[name];
});

const json = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const chat = (body: unknown) => json("POST", "/api/inference/chat", body);

test("a key says which provider it is for, so nobody has to be asked", () => {
  expect(providerOf(ANTHROPIC_KEY)).toBe("anthropic");
  expect(providerOf(OPENAI_KEY)).toBe("openai");
  expect(providerOf("hunter2")).toBeNull();
  expect(providerOf("")).toBeNull();
});

test("sealed keys open again, and a tampered one does not", () => {
  const sealed = seal(OPENAI_KEY);
  expect(sealed).not.toContain(OPENAI_KEY);
  expect(unseal(sealed)).toBe(OPENAI_KEY);
  // The same key never seals to the same bytes twice.
  expect(seal(OPENAI_KEY)).not.toBe(sealed);
  const parts = sealed.split(".");
  parts[3] = Buffer.from("tampered").toString("base64");
  expect(() => unseal(parts.join("."))).toThrow();
});

test("without a key and without credit, teaching is refused", async () => {
  expect((await chat({ model: "gpt-5-nano", messages: [] })).status).toBe(402);
});

test("a key goes in and never comes back out", async () => {
  expect((await json("PUT", "/api/model-key", { key: "not a key" })).status).toBe(400);
  const revoked = await json("PUT", "/api/model-key", { key: REVOKED });
  expect(revoked.status).toBe(422);
  expect(await (await json("GET", "/api/model-key")).json()).toEqual({ key: null });

  const saved = await json("PUT", "/api/model-key", { key: `  "${OPENAI_KEY}"\n` });
  const savedText = await saved.text();
  expect(saved.status).toBe(200);
  expect(JSON.parse(savedText)).toMatchObject({ key: { provider: "openai", last4: "aaaa" }, verified: true });
  const read = await (await json("GET", "/api/model-key")).text();
  for (const body of [savedText, read, await revoked.text()]) {
    expect(body).not.toContain(OPENAI_KEY);
    expect(body).not.toContain(REVOKED);
  }
  // Nor is it readable where it rests.
  const [row] = await db.select().from(modelKey).where(eq(modelKey.userId, userId));
  expect(JSON.stringify(row)).not.toContain(OPENAI_KEY);
  expect(unseal(row.ciphertext)).toBe(OPENAI_KEY);
  // Signed out, there is nothing here at all.
  expect((await app.request("/api/model-key", { headers: { Origin: ORIGIN } })).status).toBe(401);
});

test("with their own key the credit system neither gates nor charges, and the allowlist does not apply", async () => {
  // Still no credit on this account, and a model our price table has never heard of.
  const res = await chat({ model: "gpt-owner-only-model", messages: [{ role: "user", content: "hi" }] });
  expect(res.status).toBe(200);
  const last = seen[seen.length - 1];
  expect(last.auth).toBe(`Bearer ${OPENAI_KEY}`);
  expect(last.auth).not.toContain("the-servers-own-key");
  expect(last.body.model).toBe("gpt-owner-only-model");
  expect(await res.text()).not.toContain(OPENAI_KEY);

  const rows = await db.select().from(usage).where(eq(usage.userId, userId));
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ costMicros: 0, inputTokens: 900, outputTokens: 100, model: "gpt-owner-only-model" });
  // And the picker stops calling models unaffordable: the balance is not what pays.
  const picker = await (await json("GET", "/api/models")).json();
  expect(picker.models.length).toBeGreaterThan(0);
  expect(picker.models.every((m: { affordable: boolean }) => m.affordable)).toBe(true);
  const credits = await (await json("GET", "/api/credits")).json();
  expect(credits.spentMicros).toBe(0);
});

test("an Anthropic key is served by the Messages API: translated in, translated out, thinking kept", async () => {
  expect(await (await json("PUT", "/api/model-key", { key: ANTHROPIC_KEY })).json()).toMatchObject({ key: { provider: "anthropic", last4: "bbbb" } });
  const tools = [{ type: "function", function: { name: "describe_scene", description: "What is on the table.", parameters: { type: "object", properties: {} } } }];
  const first = await chat({ model: "gpt-5-nano", tools, messages: [{ role: "system", content: "You drive a robot." }, { role: "user", content: "clear the table" }] });
  expect(first.status).toBe(200);
  const reply = await first.json();

  const sent = claude[claude.length - 1];
  expect(sent.key).toBe(ANTHROPIC_KEY);
  expect(sent.beta).toContain("server-side-fallback-2026-07-01");
  // The owner was never asked for a model; the picker's GPT name is not sent on.
  expect(sent.body).toMatchObject({ model: ANTHROPIC_MODEL, system: "You drive a robot.", fallbacks: "default" });
  expect(sent.body.thinking).toBeUndefined();
  expect(sent.body.tools).toEqual([{ name: "describe_scene", description: "What is on the table.", input_schema: { type: "object", properties: {} } }]);
  expect(sent.body.messages).toEqual([{ role: "user", content: "clear the table" }]);

  const message = reply.choices[0].message;
  expect(reply).toMatchObject({ provider: "anthropic", model: "claude-opus-5" });
  expect(reply.choices[0].finish_reason).toBe("tool_calls");
  expect(message.content).toBe("Looking at the table.");
  expect(message.tool_calls).toEqual([{ id: "toolu_1", type: "function", function: { name: "describe_scene", arguments: "{}" } }]);
  expect(JSON.stringify(reply)).not.toContain(ANTHROPIC_KEY);

  // Next turn: the loop sends its history back as it got it, plus two tool results.
  await chat({
    model: "gpt-5-nano", tools,
    messages: [
      { role: "user", content: "clear the table" },
      message,
      { role: "tool", tool_call_id: "toolu_1", content: "{\"objects\": {}}" },
    ],
  });
  const second = claude[claude.length - 1].body.messages;
  expect(second[1]).toEqual({ role: "assistant", content: message.anthropic_content });
  expect(second[1].content[0]).toMatchObject({ type: "thinking", signature: "sig-abc" });
  expect(second[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"objects\": {}}" }] });
});

test("history from a loop that kept nothing extra is rebuilt, and parallel results share one message", () => {
  const { messages } = toAnthropic({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [
        { id: "a", function: { name: "home", arguments: "{}" } },
        { id: "b", function: { name: "gripper", arguments: "{\"position\": 0}" } },
      ] },
      { role: "tool", tool_call_id: "a", content: "ok" },
      { role: "tool", tool_call_id: "b", content: "ok" },
    ],
  });
  expect(messages[1]).toEqual({ role: "assistant", content: [
    { type: "tool_use", id: "a", name: "home", input: {} },
    { type: "tool_use", id: "b", name: "gripper", input: { position: 0 } },
  ] });
  expect(messages[2]).toEqual({ role: "user", content: [
    { type: "tool_result", tool_use_id: "a", content: "ok" },
    { type: "tool_result", tool_use_id: "b", content: "ok" },
  ] });
  expect(messages.length).toBe(3);
});

test("taking the key away puts the account back on credit", async () => {
  expect(await (await json("DELETE", "/api/model-key")).json()).toEqual({ key: null });
  expect((await db.select().from(modelKey).where(eq(modelKey.userId, userId))).length).toBe(0);
  // GET /credits above granted the welcome credit, so this is the credit path
  // answering now — with the SERVER's key, not the owner's.
  const res = await chat({ model: "gpt-5-nano", messages: [] });
  expect(res.status).toBe(200);
  expect(seen[seen.length - 1].auth).toBe("Bearer sk-the-servers-own-key");
});
