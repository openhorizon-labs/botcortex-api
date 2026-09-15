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
    platform: "openarm_v1",
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

// --- the read-back door: what a boot rebuilds its store from ------------------

const list = (platform?: string) =>
  app.request(`/api/skills${platform ? `?platform=${platform}` : ""}`, {
    headers: { Cookie: cookie, Origin: ORIGIN },
  });

const ran = (name: string, platform: string) =>
  app.request(`/api/skills/${name}/ran`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ platform }),
  });

test("the same name on two bodies is two skills", async () => {
  expect((await push({ name: "wave", description: "OpenArm wave.", code: "def run(ctx): return 'openarm'", platform: "openarm_v1" })).status).toBe(200);
  expect((await push({ name: "wave", description: "RoArm wave.", code: "def run(ctx): return 'roarm'", platform: "roarm_m2" })).status).toBe(200);

  const roarm = await (await list("roarm_m2")).json();
  expect(roarm.skills.map((s: { name: string }) => s.name)).toEqual(["wave"]);
  expect(roarm.skills[0]).toMatchObject({ code: "def run(ctx): return 'roarm'", platform: "roarm_m2", proven: false });
  expect(typeof roarm.skills[0].updatedAt).toBe("number");

  const openarm = await (await list("openarm_v1")).json();
  expect(openarm.skills.find((s: { name: string }) => s.name === "wave").code).toBe("def run(ctx): return 'openarm'");

  const everything = await (await list()).json();
  expect(everything.skills.filter((s: { name: string }) => s.name === "wave")).toHaveLength(2);
});

test("a run marks the registry copy proven; re-teaching drops the mark", async () => {
  expect((await ran("wave", "roarm_m2")).status).toBe(200);
  let rows = (await (await list("roarm_m2")).json()).skills;
  expect(rows[0].proven).toBe(true);
  // The other body's copy did not run.
  rows = (await (await list("openarm_v1")).json()).skills;
  expect(rows.find((s: { name: string }) => s.name === "wave").proven).toBe(false);

  expect((await push({ name: "wave", description: "RoArm wave, faster.", code: "def run(ctx): return 'roarm2'", platform: "roarm_m2" })).status).toBe(200);
  rows = (await (await list("roarm_m2")).json()).skills;
  expect(rows[0].proven).toBe(false);

  // A copy pushed up by a store that saw it run arrives proven.
  expect((await push({ name: "wave", description: "RoArm wave, faster.", code: "def run(ctx): return 'roarm2'", platform: "roarm_m2", proven: true })).status).toBe(200);
  rows = (await (await list("roarm_m2")).json()).skills;
  expect(rows[0].proven).toBe(true);
});

test("marking a skill the registry never received is a 404, not a silent no-op", async () => {
  expect((await ran("never_sent", "roarm_m2")).status).toBe(404);
});

test("the read-back is scoped to the session's account", async () => {
  const other = await signUp(app, "someone-else@example.com");
  const res = await app.request("/api/skills", { headers: { Cookie: other, Origin: ORIGIN } });
  expect((await res.json()).skills).toEqual([]);
  expect((await app.request("/api/skills", { headers: { Origin: ORIGIN } })).status).toBe(401);
});

// --- the public registry -----------------------------------------------------

const publish = (name: string, platform: string, published = true) =>
  app.request(`/api/skills/${name}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ platform, published }),
  });

test("a successful run publishes by default; only a proven skill can be listed; the registry needs no session", async () => {
  // wave on roarm_m2 ran in the test above and is therefore already listed;
  // wave on openarm_v1 never ran.
  expect((await (await app.request("/api/registry", { headers: { Origin: ORIGIN } })).json()).count).toBe(1);
  expect((await publish("wave", "openarm_v1")).status).toBe(409);
  expect((await publish("nope", "roarm_m2")).status).toBe(404);
  // Taking it down is the owner's call, and putting it back is too.
  expect(await (await publish("wave", "roarm_m2", false)).json()).toMatchObject({ ok: true, published: false });
  expect((await (await app.request("/api/registry", { headers: { Origin: ORIGIN } })).json()).count).toBe(0);
  const res = await publish("wave", "roarm_m2");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, published: true });

  const anyone = await app.request("/api/registry", { headers: { Origin: ORIGIN } });
  expect(anyone.status).toBe(200);
  const body = await anyone.json();
  expect(body.count).toBe(1);
  expect(body.platforms).toEqual([
    { name: "roarm_m2", skills: [expect.objectContaining({ name: "wave", platform: "roarm_m2", code: "def run(ctx): return 'roarm2'" })] },
  ]);
  // No account id leaks onto the public page.
  expect(Object.keys(body.platforms[0].skills[0]).sort()).toEqual(["code", "description", "name", "platform", "updatedAt"]);
  expect((await (await app.request("/api/registry?platform=openarm_v1", { headers: { Origin: ORIGIN } })).json()).count).toBe(0);
});

test("re-teaching a published skill takes it down until it has run again, and the run puts it back", async () => {
  expect((await push({ name: "wave", description: "RoArm wave, v3.", code: "def run(ctx): return 'roarm3'", platform: "roarm_m2" })).status).toBe(200);
  expect((await (await app.request("/api/registry", { headers: { Origin: ORIGIN } })).json()).count).toBe(0);
  expect((await ran("wave", "roarm_m2")).status).toBe(200);
  expect((await (await app.request("/api/registry", { headers: { Origin: ORIGIN } })).json()).count).toBe(1);
  // A copy pushed up already proven (a store restoring its skills) is listed too.
  expect((await push({ name: "lift", description: "Lift.", code: "def run(ctx): pass", platform: "roarm_m2", proven: true })).status).toBe(200);
  expect((await (await app.request("/api/registry", { headers: { Origin: ORIGIN } })).json()).count).toBe(2);
  expect(await (await publish("lift", "roarm_m2", false)).json()).toMatchObject({ published: false });
  expect((await (await list("roarm_m2")).json()).skills.find((s: { name: string }) => s.name === "wave").published).toBe(true);
  expect(await (await publish("wave", "roarm_m2", false)).json()).toMatchObject({ published: false });
  expect((await (await app.request("/api/registry", { headers: { Origin: ORIGIN } })).json()).count).toBe(0);
});
