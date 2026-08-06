/**
 * The registry's cookie door — the browser sim's half of skill sync.
 *
 * The robot-key door is covered in robot-keys.test.ts; what matters here is
 * that a skill taught in the browser lands in the SAME registry row shape a
 * robot's would, that a session is required, and that the size guard holds.
 */
import { beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { MAX_SKILL_CHARS } from "../src/registry.js";
import { skill } from "../src/app-schema.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let cookie: string;
let userId: string;

const push = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  ({ app, db } = await makeApp());
  cookie = await signUp(app);
  const me = await app.request("/api/me", { headers: { Cookie: cookie, Origin: ORIGIN } });
  userId = (await me.json()).user.id;
});

test("a browser-taught skill lands in the account registry", async () => {
  const res = await push({
    name: "wave_hello",
    description: "Wave the right arm.",
    code: "def run(ctx): pass",
    platform: "openarm_v1",
  });
  expect(res.status).toBe(200);

  const rows = await db.select().from(skill).where(eq(skill.userId, userId));
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("wave_hello");
  expect(rows[0].platform).toBe("openarm_v1");
});

test("re-teaching updates the row rather than duplicating it", async () => {
  const res = await push({
    name: "wave_hello",
    description: "Wave twice.",
    code: "def run(ctx): return 2",
  });
  expect(res.status).toBe(200);

  const rows = await db.select().from(skill).where(eq(skill.userId, userId));
  expect(rows).toHaveLength(1);
  expect(rows[0].description).toBe("Wave twice.");
});

test("no session, no write", async () => {
  const res = await app.request("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ name: "x", description: "y", code: "z" }),
  });
  expect(res.status).toBe(401);
});

test("an oversized skill is refused, not truncated", async () => {
  const res = await push({
    name: "bloated",
    description: "Too big.",
    code: "#".repeat(MAX_SKILL_CHARS),
  });
  expect(res.status).toBe(413);
});
