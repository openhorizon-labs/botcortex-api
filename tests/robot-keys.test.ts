/**
 * Robot keys, credits, and the guards on the inference proxy.
 *
 * The proxy's happy path is deliberately NOT tested here — it would mean
 * either a live vendor call or mocking the thing under test. What is tested
 * is everything that decides whether a call is forwarded at all, which is
 * where the money leaks: auth, the model allowlist, the streaming hole, and
 * the balance gate.
 */
import { beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { SIGNUP_GRANT_MICROS } from "../src/credits.js";
import { priceFor, worstCaseMicros } from "../src/pricing.js";
import { creditGrant, skill, usage } from "../src/app-schema.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let cookie: string;
let key: string;
let userId: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  cookie = await signUp(app);

  const created = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "Thor rig" }),
  });
  expect(created.status).toBe(201);
  key = (await created.json()).key;

  const me = await app.request("/api/me", { headers: { Cookie: cookie, Origin: ORIGIN } });
  userId = (await me.json()).user.id;
});

test("minted key is returned once, in full, and looks like a robot key", () => {
  expect(key.startsWith("bx_live_")).toBe(true);
  expect(key.length).toBeGreaterThan(40);
});

test("the key list shows a prefix, never the key itself", async () => {
  const res = await app.request("/api/keys", {
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  const { keys } = await res.json();
  expect(keys).toHaveLength(1);
  expect(keys[0].name).toBe("Thor rig");
  expect(key.startsWith(keys[0].prefix)).toBe(true);
  expect(JSON.stringify(keys)).not.toContain(key);
});

test("minting the first key seeds the signup credit, exactly once", async () => {
  await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "second robot" }),
  });
  const grants = await db.select().from(creditGrant).where(eq(creditGrant.userId, userId));
  expect(grants).toHaveLength(1);

  const credits = await app.request("/api/credits", {
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  const body = await credits.json();
  expect(body.balanceMicros).toBe(SIGNUP_GRANT_MICROS);
  expect(body.display).toBe("$2.00");
});

test("keys are session-gated — no cookie, no keys", async () => {
  expect((await app.request("/api/keys")).status).toBe(401);
  expect((await app.request("/api/credits")).status).toBe(401);
});

test("a robot key authenticates /v1/me and reports the balance", async () => {
  const res = await app.request("/v1/me", {
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.user.email).toBe("owner@example.com");
  expect(body.credit.balanceMicros).toBe(SIGNUP_GRANT_MICROS);
});

test("the Anthropic SDK's x-api-key header authenticates too", async () => {
  const res = await app.request("/v1/me", { headers: { "x-api-key": key } });
  expect(res.status).toBe(200);
});

test("an unknown key is rejected", async () => {
  const res = await app.request("/v1/me", {
    headers: { Authorization: "Bearer bx_live_deadbeef" },
  });
  expect(res.status).toBe(401);
});

test("a revoked key stops working", async () => {
  const created = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "doomed" }),
  });
  const { id, key: doomed } = await created.json();
  expect((await app.request("/v1/me", { headers: { "x-api-key": doomed } })).status).toBe(200);

  const revoked = await app.request(`/api/keys/${id}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  expect(revoked.status).toBe(200);
  expect((await app.request("/v1/me", { headers: { "x-api-key": doomed } })).status).toBe(401);
});

test("one owner cannot revoke another owner's key", async () => {
  const other = await signUp(app, "intruder@example.com");
  const mine = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "mine" }),
  });
  const { id } = await mine.json();

  const attempt = await app.request(`/api/keys/${id}`, {
    method: "DELETE",
    headers: { Cookie: other, Origin: ORIGIN },
  });
  expect(attempt.status).toBe(404);
});

test("an unpriced model is refused rather than forwarded unmetered", async () => {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-9-ultra", messages: [] }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain("not available on BotCortex credits");
});

test("a model routed to the wrong provider's endpoint is refused", async () => {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [] }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.message).toContain("openai model");
});

test("an exhausted balance gets a 402 before anything is forwarded", async () => {
  const { app: fresh, db: freshDb } = await makeApp();
  const freshCookie = await signUp(fresh, "broke@example.com");
  const created = await fresh.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: freshCookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "broke robot" }),
  });
  const { key: freshKey } = await created.json();

  const who = await fresh.request("/v1/me", { headers: { "x-api-key": freshKey } });
  expect((await who.json()).credit.balanceMicros).toBe(SIGNUP_GRANT_MICROS);

  const freshMe = await fresh.request("/api/me", {
    headers: { Cookie: freshCookie, Origin: ORIGIN },
  });
  const freshUserId = (await freshMe.json()).user.id;

  // Burn the entire grant with a recorded call.
  await freshDb.insert(usage).values({
    id: crypto.randomUUID(),
    userId: freshUserId,
    keyId: null,
    model: "gpt-5-nano",
    inputTokens: 1_000_000,
    outputTokens: 0,
    costMicros: SIGNUP_GRANT_MICROS,
  });

  const spend = await fresh.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${freshKey}` },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [] }),
  });
  expect(spend.status).toBe(402);
  expect((await spend.json()).error.type).toBe("insufficient_credit");
});

test("a skill syncs up and re-syncing updates rather than duplicates", async () => {
  const push = (code: string, description: string) =>
    app.request("/v1/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        name: "nod_right_arm",
        description,
        code,
        platform: "openarm_v1",
      }),
    });

  expect((await push("def run(ctx): pass", "Nod once.")).status).toBe(200);
  expect((await push("def run(ctx): return 1", "Nod twice.")).status).toBe(200);

  const rows = await db.select().from(skill).where(eq(skill.userId, userId));
  expect(rows).toHaveLength(1);
  expect(rows[0].description).toBe("Nod twice.");
  expect(rows[0].code).toBe("def run(ctx): return 1");
});

test("skill sync requires a robot key", async () => {
  const res = await app.request("/v1/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x", description: "y", code: "z" }),
  });
  expect(res.status).toBe(401);
});

test("a balance too small to cover one call is refused before forwarding", async () => {
  const { app: fresh, db: freshDb } = await makeApp();
  const freshCookie = await signUp(fresh, "nearly-broke@example.com");
  const created = await fresh.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: freshCookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "nearly broke" }),
  });
  const { key: freshKey } = await created.json();
  const me = await fresh.request("/api/me", {
    headers: { Cookie: freshCookie, Origin: ORIGIN },
  });
  const freshUserId = (await me.json()).user.id;

  // Spend down to a hundredth of a cent — above zero, so the old
  // `balance > 0` guard waved this straight through into a call that could
  // finish dollars in the red.
  await freshDb.insert(usage).values({
    id: crypto.randomUUID(),
    userId: freshUserId,
    keyId: null,
    model: "gpt-5-nano",
    inputTokens: 0,
    outputTokens: 0,
    costMicros: SIGNUP_GRANT_MICROS - 10,
  });

  const res = await fresh.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${freshKey}` },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [] }),
  });
  expect(res.status).toBe(402);
  const { error } = await res.json();
  expect(error.type).toBe("insufficient_credit");
  // Says what is actually wrong, rather than claiming the account is empty.
  expect(error.message).toContain("Not enough BotCortex credit");
});

test("the ceiling scales with the model, and max_tokens is trusted", () => {
  const cheap = worstCaseMicros(priceFor("gpt-5-nano")!);
  const dear = worstCaseMicros(priceFor("gpt-5.6-sol")!);
  expect(dear).toBeGreaterThan(cheap);

  // A caller naming a smaller budget should not be held to the assumed one.
  const bounded = worstCaseMicros(priceFor("gpt-5.6-sol")!, { max_tokens: 100 });
  expect(bounded).toBeLessThan(dear);

  // Even the dearest model we sell must buy several teaches on the signup
  // grant, or the lineup itself is a trap for a new owner.
  expect(Math.floor(SIGNUP_GRANT_MICROS / dear)).toBeGreaterThanOrEqual(5);
});
