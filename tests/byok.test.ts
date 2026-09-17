/**
 * Bring your own key, held by the backend. OpenAI keys only, for now.
 *
 * Two promises, each of which has a way to be quietly false: the key never
 * comes back out (not in a response, not readable in the database), and a call
 * made with it is never gated or charged by our credit. And one thing that is
 * deliberately NOT done: nothing is decided from what a key looks like.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { modelKey, usage } from "../src/app-schema.js";
import { seal, unseal } from "../src/byok.js";

const OPENAI_KEY = "sk-proj-owner0000000000000000aaaa";
/** Not an OpenAI key. The stub, like OpenAI, says so. */
const SOMEONE_ELSES = "sk-ant-api03-owner00000000000000bbbb";
const REVOKED = "sk-proj-revoked000000000000000000";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let cookie: string;
let userId: string;
let openai: ReturnType<typeof Bun.serve>;
const seen: { auth: string | null; body: any }[] = [];

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
        return auth === `Bearer ${REVOKED}` || auth === `Bearer ${SOMEONE_ELSES}` ? Response.json({ error: { message: "bad key" } }, { status: 401 }) : Response.json({ data: [] });
      }
      const body = await req.json();
      seen.push({ auth, body });
      return Response.json({ id: "chatcmpl_own", model: body.model, choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 900, completion_tokens: 100 } });
    },
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${openai.port}/chat/completions`;
  process.env.OPENAI_API_KEY = "sk-the-servers-own-key";
});

afterAll(() => {
  openai?.stop(true);
  for (const name of ["OPENAI_UPSTREAM_URL", "OPENAI_API_KEY"]) delete process.env[name];
});

const json = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const chat = (body: unknown) => json("POST", "/api/inference/chat", body);

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
  expect((await json("PUT", "/api/model-key", {})).status).toBe(400);
  // Another provider's key is not recognised by its shape and waved through,
  // or turned away by its shape either: OpenAI is asked, and OpenAI says no.
  const foreign = await json("PUT", "/api/model-key", { key: SOMEONE_ELSES });
  expect(foreign.status).toBe(422);
  expect((await foreign.json()).error).toContain("Only OpenAI keys are supported for now");
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

test("taking the key away puts the account back on credit", async () => {
  expect(await (await json("DELETE", "/api/model-key")).json()).toEqual({ key: null });
  expect((await db.select().from(modelKey).where(eq(modelKey.userId, userId))).length).toBe(0);
  // GET /credits above granted the welcome credit, so this is the credit path
  // answering now — with the SERVER's key, not the owner's.
  const res = await chat({ model: "gpt-5-nano", messages: [] });
  expect(res.status).toBe(200);
  expect(seen[seen.length - 1].auth).toBe("Bearer sk-the-servers-own-key");
});
