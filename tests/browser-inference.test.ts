/**
 * The browser sim's door into the proxy.
 *
 * The agent loop for the browser sim runs in the page, so it needs inference —
 * but handing browser JavaScript a durable `bx_live_` key to hold would be a
 * worse trade than any convenience it bought. It uses the session cookie
 * instead, and spends the same credit through the same function.
 *
 * What is worth testing is precisely that "the same function" stays true: a
 * second billing path that quietly stopped charging, or accepted a model the
 * robot's path refuses, is the failure this file exists to catch.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { SIGNUP_GRANT_MICROS } from "../src/credits.js";
import { usage } from "../src/app-schema.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let cookie: string;
let userId: string;
let server: ReturnType<typeof Bun.serve>;
let seen: Headers | null = null;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  cookie = await signUp(app, "browser@example.com");
  userId = (
    await (await app.request("/api/me", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()
  ).user.id;
  // Minting a key is what seeds the signup grant; a browser-only account still
  // needs credit, so this stands in for however that lands in production.
  await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "grant seed" }),
  });

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen = req.headers;
      await req.json();
      return Response.json({
        id: "chatcmpl_browser_stub",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 800, completion_tokens: 200 },
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

const call = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/inference/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

test("a signed-in browser can reach the model", async () => {
  const res = await call({ model: "gpt-5-nano", messages: [] }, { Cookie: cookie });
  expect(res.status).toBe(200);
  expect((await res.json()).id).toBe("chatcmpl_browser_stub");
});

test("without a session there is no inference", async () => {
  expect((await call({ model: "gpt-5-nano", messages: [] })).status).toBe(401);
});

test("the vendor key stays server-side", async () => {
  await call({ model: "gpt-5-nano", messages: [] }, { Cookie: cookie });
  expect(seen!.get("authorization")).toBe("Bearer sk-server-side-secret");
});

test("browser spend is metered exactly as a robot's is, with no key attached", async () => {
  const before = await db.select().from(usage).where(eq(usage.userId, userId));
  await call({ model: "gpt-5-nano", messages: [] }, { Cookie: cookie });
  const after = await db.select().from(usage).where(eq(usage.userId, userId));
  expect(after.length).toBe(before.length + 1);

  const row = after[after.length - 1];
  expect(row.model).toBe("gpt-5-nano");
  expect(row.inputTokens).toBe(800);
  expect(row.outputTokens).toBe(200);
  // Same table the robot path bills from: $0.05/Mtok in, $0.40/Mtok out.
  expect(row.costMicros).toBe(Math.ceil(800 * 0.05 + 200 * 0.4));
  // No robot key was involved, and the schema has always allowed that. The row
  // still names the user, which is what the balance is derived from.
  expect(row.keyId).toBeNull();
});

test("the model allowlist is not a second, laxer list", async () => {
  const res = await call({ model: "gpt-9-ultra", messages: [] }, { Cookie: cookie });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain("not available on BotCortex credits");
});

test("a model belonging to the other vendor is refused here too", async () => {
  const res = await app.request("/api/inference/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [] }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain("openai model");
});

test("an exhausted account cannot teach in the browser either", async () => {
  const { app: fresh, db: freshDb } = await makeApp();
  const freshCookie = await signUp(fresh, "broke-browser@example.com");
  const freshUserId = (
    await (
      await fresh.request("/api/me", { headers: { Cookie: freshCookie, Origin: ORIGIN } })
    ).json()
  ).user.id;
  await fresh.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: freshCookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "seed" }),
  });
  await freshDb.insert(usage).values({
    id: crypto.randomUUID(),
    userId: freshUserId,
    keyId: null,
    model: "gpt-5-nano",
    inputTokens: 0,
    outputTokens: 0,
    costMicros: SIGNUP_GRANT_MICROS,
  });

  const res = await fresh.request("/api/inference/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: freshCookie, Origin: ORIGIN },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [] }),
  });
  expect(res.status).toBe(402);
  expect((await res.json()).error.type).toBe("insufficient_credit");
});

test("one account's session cannot spend another's credit", async () => {
  const other = await signUp(app, "other-browser@example.com");
  const otherId = (
    await (await app.request("/api/me", { headers: { Cookie: other, Origin: ORIGIN } })).json()
  ).user.id;
  // Give them credit of their own, or the call 402s and the test passes for
  // the wrong reason — nothing was billed to anyone.
  await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: other, Origin: ORIGIN },
    body: JSON.stringify({ name: "their seed" }),
  });

  const mineBefore = await db.select().from(usage).where(eq(usage.userId, userId));
  await call({ model: "gpt-5-nano", messages: [] }, { Cookie: other });
  const mineAfter = await db.select().from(usage).where(eq(usage.userId, userId));
  const theirs = await db.select().from(usage).where(eq(usage.userId, otherId));

  expect(mineAfter.length).toBe(mineBefore.length);
  expect(theirs.length).toBeGreaterThan(0);
});
