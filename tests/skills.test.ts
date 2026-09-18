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
import { handleFor } from "../src/handles.js";
import { MAX_SKILL_CHARS, countRun } from "../src/registry.js";
import { runToken, runTokenValid } from "../src/routes/registry.js";
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
  // Taking it down is NOT the owner's call: every skill that runs joins the
  // registry, which is the only reason the registry is worth reading. The app
  // disables its control and the endpoint refuses, so calling it directly is
  // not a way round the disabled button.
  const down = await publish("wave", "roarm_m2", false);
  expect(down.status).toBe(402);
  expect(await down.json()).toMatchObject({ code: "unpublish_not_available" });
  expect((await (await app.request("/api/registry", { headers: { Origin: ORIGIN } })).json()).count).toBe(1);
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
  // The row's own id is public — it is what a share link addresses — and the
  // account's never is.
  expect(Object.keys(body.platforms[0].skills[0]).sort()).toEqual(["author", "code", "description", "id", "name", "platform", "runs", "updatedAt"]);
  expect(body.platforms[0].skills[0].author).toEqual({ handle: "test" });
  const id = body.platforms[0].skills[0].id as string;
  const one = await app.request(`/api/registry/skills/${id}`, { headers: { Origin: ORIGIN } });
  expect(one.status).toBe(200);
  const shown = (await one.json()).skill;
  expect(shown).toMatchObject({ id, name: "wave", platform: "roarm_m2" });
  // One skill's page names its author: the name they signed up with, a handle
  // made from it, and what they have done in public. Never the email, never
  // the account id — by key or by value.
  expect(Object.keys(shown.author).sort()).toEqual(["avatar", "bio", "handle", "joinedAt", "name", "platforms", "runs", "skills"]);
  expect(shown.author.handle).toBe(handleFor(shown.author.name));
  expect(shown.author).toMatchObject({ skills: 1, platforms: ["roarm_m2"], runs: 0 });
  expect(Object.keys(shown)).not.toContain("userId");
  expect(JSON.stringify(shown)).not.toContain("@");
  expect((await app.request("/api/registry/skills/not-a-skill", { headers: { Origin: ORIGIN } })).status).toBe(404);
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
  // Neither can be withdrawn, so both stay listed.
  expect((await publish("lift", "roarm_m2", false)).status).toBe(402);
  expect((await (await list("roarm_m2")).json()).skills.find((s: { name: string }) => s.name === "wave").published).toBe(true);
  expect((await publish("wave", "roarm_m2", false)).status).toBe(402);
  expect((await (await app.request("/api/registry", { headers: { Origin: ORIGIN } })).json()).count).toBe(2);
});

test("re-teaching still takes a skill down until it runs again — the automatic path is untouched", async () => {
  // The only thing that unlists a skill is editing it, and only until the new
  // version has run. That is the runtime's own bookkeeping, not an owner
  // withdrawing work, so the 402 above must not have broken it.
  expect((await push({ name: "lift", description: "Lift, v2.", code: "def run(ctx): return 2", platform: "roarm_m2" })).status).toBe(200);
  expect((await (await list("roarm_m2")).json()).skills.find((s: { name: string }) => s.name === "lift").published).toBe(false);
  expect((await ran("lift", "roarm_m2")).status).toBe(200);
  expect((await (await list("roarm_m2")).json()).skills.find((s: { name: string }) => s.name === "lift").published).toBe(true);
});

test("a handle is the first word of the name, in ASCII, and never empty or reserved", () => {
  expect(handleFor("Saidev Dhal (Dev)")).toBe("saidev");
  expect(handleFor("  José  Núñez ")).toBe("jose");
  // Too short, not ASCII, nothing usable, or a word we keep for ourselves.
  for (const name of ["Al B", "李 雷", "!!! ???", "", "Admin Person"]) expect(handleFor(name)).toBe("maker");
});

test("handles are unique, changeable, and an author page lists what they published", async () => {
  // Two accounts with the same name cannot share a handle.
  const second = await signUp(app, "second@example.com");
  const mine = await (await app.request("/api/profile", { headers: { Cookie: cookie, Origin: ORIGIN } })).json();
  const theirs = await (await app.request("/api/profile", { headers: { Cookie: second, Origin: ORIGIN } })).json();
  expect(mine.handle).toBe("test");
  expect(theirs.handle).toBe("test2");
  // A new profile starts from the sign-up name, has not been asked yet, and
  // already has a generated avatar whose URL says nothing about the person.
  expect(theirs).toMatchObject({ firstName: "Test", lastName: "Owner", bio: "", onboarded: false });
  expect(theirs.avatar).toMatch(/^https:\/\/api\.dicebear\.com\/9\.x\/bottts-neutral\/svg\?seed=[0-9a-f]{16}$/);
  expect(theirs.avatar).not.toMatch(/test|owner|second|example/i);

  const put = (as: string, handle: string) =>
    app.request("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: as, Origin: ORIGIN },
      body: JSON.stringify({ handle }),
    });
  expect((await put(second, "test")).status).toBe(409);
  expect((await put(second, "admin")).status).toBe(400);
  expect((await put(second, "No Spaces!")).status).toBe(400);
  expect(await (await put(second, "@Robo_Fan")).json()).toMatchObject({ handle: "robo_fan" });

  // The page exists for someone who has published, and only for them.
  const page = await app.request("/api/registry/authors/test", { headers: { Origin: ORIGIN } });
  expect(page.status).toBe(200);
  const shown = await page.json();
  expect(shown.author).toMatchObject({ handle: "test", name: "Test Owner" });
  expect(shown.skills.length).toBe(shown.author.skills);
  expect(JSON.stringify(shown)).not.toContain("example.com");
  expect((await app.request("/api/registry/authors/robo_fan", { headers: { Origin: ORIGIN } })).status).toBe(404);
  expect((await app.request("/api/registry/authors/nobody", { headers: { Origin: ORIGIN } })).status).toBe(404);
});

test("runs by other people rank the registry; reloads and the author's own runs do not count", async () => {
  const list = async () =>
    (await (await app.request("/api/registry?platform=roarm_m2", { headers: { Origin: ORIGIN } })).json()).platforms[0].skills as {
      id: string; name: string; runs: number;
    }[];
  const before = await list();
  expect(before.length).toBeGreaterThan(1);
  const last = before[before.length - 1];
  // What the app signs with (see registryRoutes' default).
  const SALT = process.env.BETTER_AUTH_SECRET ?? "botcortex";
  // A token from the skill's page, old enough to have been followed by a run.
  const token = runToken(last.id, SALT, Date.now() - 10_000);
  const ran = (headers: Record<string, string>, body: unknown = { token }) =>
    app.request(`/api/registry/skills/${last.id}/ran`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  // No token, a token for another skill, one from the future, one gone stale: not runs.
  const stranger = { "x-forwarded-for": "203.0.113.200", "user-agent": "z" };
  expect((await ran(stranger, {})).status).toBe(403);
  expect((await ran(stranger, { token: runToken(before[0].id, SALT, Date.now() - 10_000) })).status).toBe(403);
  expect((await ran(stranger, { token: runToken(last.id, SALT) })).status).toBe(403);
  expect((await ran(stranger, { token: runToken(last.id, SALT, Date.now() - 7 * 3600_000) })).status).toBe(403);
  expect((await ran(stranger, { token: runToken(last.id, "someone-elses-secret", Date.now() - 10_000) })).status).toBe(403);
  // The page hands out a real one.
  const served = await (await app.request(`/api/registry/skills/${last.id}`, { headers: { Origin: ORIGIN } })).json();
  expect(runTokenValid(served.runToken, last.id, SALT, Date.now() + 5_000)).toBe(true);

  // The author pressing Run on their own skill is not a vote.
  expect(await (await ran({ Cookie: cookie })).json()).toEqual({ counted: false, runs: 0 });
  // A stranger is, once a day, however often they reload.
  expect(await (await ran({ "x-forwarded-for": "203.0.113.7", "user-agent": "a" })).json()).toEqual({ counted: true, runs: 1 });
  expect(await (await ran({ "x-forwarded-for": "203.0.113.7", "user-agent": "a" })).json()).toEqual({ counted: false, runs: 1 });
  expect(await (await ran({ "x-forwarded-for": "203.0.113.8", "user-agent": "a" })).json()).toEqual({ counted: true, runs: 2 });

  // The least recent skill is now first: it is the one people run.
  const after = await list();
  expect(after[0]).toMatchObject({ id: last.id, runs: 2 });
  // An unknown skill has no valid token to present, so it is refused the same way.
  expect((await app.request("/api/registry/skills/nope/ran", { method: "POST", headers: { Origin: ORIGIN } })).status).toBe(403);
});

test("the profile step: names, a bio, a reshuffled avatar, asked once", async () => {
  const me = await signUp(app, "profile@example.com");
  const put = (body: unknown) =>
    app.request("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: me, Origin: ORIGIN },
      body: JSON.stringify(body),
    });
  const before = await (await app.request("/api/profile", { headers: { Cookie: me, Origin: ORIGIN } })).json();

  // While typing: someone else's username is taken, a reserved word is
  // reserved, your own is yours, and a free one is free.
  const free = async (handle: string) =>
    (await app.request(`/api/profile/handle/${encodeURIComponent(handle)}`, { headers: { Cookie: me, Origin: ORIGIN } })).json();
  expect(await free("test")).toEqual({ available: false, code: "taken", error: "That username is taken." });
  expect(await free("TEST")).toMatchObject({ available: false, code: "taken" });
  expect(await free("admin")).toMatchObject({ available: false, code: "reserved" });
  expect(await free("a b")).toMatchObject({ available: false, code: "invalid" });
  expect(await free(before.handle)).toEqual({ available: true });
  expect(await free("ada_l")).toEqual({ available: true });
  expect((await app.request("/api/profile/handle/ada_l", { headers: { Origin: ORIGIN } })).status).toBe(401);

  // Refusals name the field, so the form can put the message beside it.
  expect(await (await put({ firstName: "  " })).json()).toMatchObject({ field: "firstName" });
  expect(await (await put({ bio: "x".repeat(161) })).json()).toMatchObject({ field: "bio" });
  expect((await put({ handle: "test", firstName: "Ada" })).status).toBe(409);

  const saved = await (
    await put({ handle: "ada_l", firstName: " Ada ", lastName: "Lovelace", bio: "Teaches an SO-101\nto sort blocks.", done: true })
  ).json();
  expect(saved).toMatchObject({
    handle: "ada_l", firstName: "Ada", lastName: "Lovelace", bio: "Teaches an SO-101 to sort blocks.", onboarded: true,
  });
  expect(saved.avatar).toBe(before.avatar);

  const shuffled = await (await put({ shuffleAvatar: true })).json();
  expect(shuffled.avatar).not.toBe(before.avatar);
  expect(shuffled).toMatchObject({ firstName: "Ada", bio: "Teaches an SO-101 to sort blocks." });

  // The account's own name follows, so the app and the skill page agree.
  const session = await (await app.request("/api/me", { headers: { Cookie: me, Origin: ORIGIN } })).json();
  expect(session.user.name).toBe("Ada Lovelace");

  // Skipping is also an answer: asked once, either way.
  const skipper = await signUp(app, "skipper@example.com");
  const skipped = await app.request("/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: skipper, Origin: ORIGIN },
    body: JSON.stringify({ done: true }),
  });
  const left = await skipped.json();
  expect(left).toMatchObject({ onboarded: true, firstName: "Test", lastName: "Owner" });
  // Whichever "test<n>" was free: the handle still exists, made from the name.
  expect(left.handle).toMatch(/^test\d*$/);
});

test("an account with no name yet still has a handle, a profile to fill in, and a word on its skills", async () => {
  // Sign-up asks for an email and a password; the profile step asks the rest.
  const nameless = await signUp(app, "nameless@example.com", "");
  const mine = await (await app.request("/api/profile", { headers: { Cookie: nameless, Origin: ORIGIN } })).json();
  expect(mine).toMatchObject({ firstName: "", lastName: "", onboarded: false });
  expect(mine.handle).toMatch(/^maker\d+$/);

  await app.request("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: nameless, Origin: ORIGIN },
    body: JSON.stringify({ name: "nod", description: "Nods.", code: "def run(ctx): pass", platform: "so101", proven: true }),
  });
  const page = await (await app.request(`/api/registry/authors/${mine.handle}`, { headers: { Origin: ORIGIN } })).json();
  expect(page.author.name).toBe("Maker");
});

test("one visitor cannot vote for the whole registry in a day", async () => {
  const { db } = await makeApp();
  const owner = crypto.randomUUID();
  const { user } = await import("../src/auth-schema.js");
  const { skill } = await import("../src/app-schema.js");
  await db.insert(user).values({ id: owner, name: "Owner", email: `${owner}@example.com` });
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
  for (const id of ids) {
    await db.insert(skill).values({ id, userId: owner, name: `s_${id.slice(0, 6)}`, description: "d", code: "c", platform: "so101", proven: true, published: true });
  }
  const outcomes = [];
  for (const id of ids) outcomes.push((await countRun(db, id, "visitor-a", "2026-09-17", null, 3))!.counted);
  expect(outcomes).toEqual([true, true, true, false]);
  // Someone else, and the same visitor tomorrow, still count.
  expect((await countRun(db, ids[3], "visitor-b", "2026-09-17", null, 3))!.counted).toBe(true);
  expect((await countRun(db, ids[3], "visitor-a", "2026-09-18", null, 3))!.counted).toBe(true);
});

test("the owner can delete a draft, and only a draft", async () => {
  // Task 3397c007 left a skill on the registry that had done nothing; the
  // sidebar now offers Delete for skills that never ran. A proven one is
  // published, and taking it down stays the paid capability.
  const res = await push({
    name: "half_idea",
    description: "A draft.",
    code: "def run(ctx): pass",
    platform: "openarm_v1",
  });
  expect(res.status).toBe(200);

  const wrongBody = await app.request("/api/skills/half_idea?platform=panda", {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  expect(wrongBody.status).toBe(404);

  const gone = await app.request("/api/skills/half_idea?platform=openarm_v1", {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  expect(gone.status).toBe(200);
  expect(await db.select().from(skill).where(eq(skill.name, "half_idea"))).toHaveLength(0);

  await push({ name: "works", description: "Works.", code: "def run(ctx): pass", platform: "openarm_v1", proven: true });
  const refused = await app.request("/api/skills/works?platform=openarm_v1", {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe("published_skill");
  expect(await db.select().from(skill).where(eq(skill.name, "works"))).toHaveLength(1);

  const nobody = await app.request("/api/skills/works?platform=openarm_v1", { method: "DELETE", headers: { Origin: ORIGIN } });
  expect(nobody.status).toBe(401);
});
