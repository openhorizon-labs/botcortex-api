/**
 * Runs kept as training data: both doors, the link between a failure and its
 * repair, and everything a public client could send to abuse the table.
 */
import { beforeAll, expect, test } from "bun:test";

import { and, eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { episode } from "../src/app-schema.js";
import { MAX_TICKS, unpackTicks } from "../src/episodes.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let cookie: string;
let userId: string;

const say = (body: unknown, as = cookie) =>
  app.request("/api/episodes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: as, Origin: ORIGIN },
    body: JSON.stringify(body),
  });

const run = (id: string, ok: boolean, more: Record<string, unknown> = {}) => ({
  event: "episode",
  episode: {
    id,
    version: 1,
    ts: "2026-09-17T10:00:00+00:00",
    platform: "roarm_m2",
    backend: "WasmRobot",
    fps: 20,
    instruction: "put the red block in the tray",
    skill: "red_to_tray",
    params: {},
    phase: "executed",
    executed: true,
    ok,
    code: "def run(ctx): pass",
    code_sha: ok ? "bbbb" : "aaaa",
    names: ["arm.j1", "arm.j2", "arm.j3", "arm.gripper"],
    objects: ["red_block"],
    scene_before: { red_block: [0.26, 0.02, 0.02] },
    scene_after: { red_block: [0.31, -0.2, 0.03] },
    ticks: {
      state: [[0, 0, 90, 0], [1, 0, 90, 0]],
      action: [[1, 0, 90, 0], [2, 0, 90, 0]],
      poses: [[[0.26, 0.02, 0.02, 1, 0, 0, 0]], [[0.26, 0.02, 0.02, 1, 0, 0, 0]]],
    },
    ...more,
  },
});

const mine = (id: string) =>
  db.select().from(episode).where(and(eq(episode.userId, userId), eq(episode.id, id)));

beforeAll(async () => {
  ({ app, db } = await makeApp());
  cookie = await signUp(app);
  userId = (await (await app.request("/api/me", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()).user.id;
});

test("a run from a browser tab is kept, columns for asking and ticks for training", async () => {
  const res = await say(run("e1789600000001-red_to_tray", false, { kind: "collision", primitive: "move_to_point", note: "ERROR: hit the block" }));
  expect(res.status).toBe(200);

  const [row] = await mine("e1789600000001-red_to_tray");
  expect(row).toMatchObject({ source: "browser", platform: "roarm_m2", skill: "red_to_tray", ok: false, kind: "collision", length: 2, fps: 20, codeSha: "aaaa" });
  expect(row.detail.scene_before).toEqual({ red_block: [0.26, 0.02, 0.02] });
  expect(unpackTicks(row.ticksGz).action).toEqual([[1, 0, 90, 0], [2, 0, 90, 0]]);
  expect(row.ticksGz.length).toBeLessThan(400);
});

test("the same run said twice is one run", async () => {
  await say(run("e1789600000001-red_to_tray", false));
  expect(await mine("e1789600000001-red_to_tray")).toHaveLength(1);
});

test("a failure is tagged with its memory record and finds the run that repaired it", async () => {
  await say({ event: "tag", id: "e1789600000001-red_to_tray", fields: { failure_id: "f1789600000001-red_to_tray", ok: true } });
  await say(run("e1789600000002-red_to_tray", true));
  const res = await say({ event: "link", success: "e1789600000002-red_to_tray", failed: ["e1789600000001-red_to_tray"] });
  expect(res.status).toBe(200);

  const [failed] = await mine("e1789600000001-red_to_tray");
  const [fixed] = await mine("e1789600000002-red_to_tray");
  expect(failed.failureId).toBe("f1789600000001-red_to_tray");
  expect(failed.ok).toBe(false); // a tag cannot rewrite the outcome
  expect(failed.repairedBy).toBe("e1789600000002-red_to_tray");
  expect(fixed.repairs).toEqual(["e1789600000001-red_to_tray"]);

  const summary = await (await app.request("/api/episodes/summary", { headers: { Cookie: cookie, Origin: ORIGIN } })).json();
  expect(summary).toMatchObject({ episodes: 2, succeeded: 1, failed: 1, repaired: 1, failure_kinds: { collision: 1 }, platforms: ["roarm_m2"] });
});

test("one account cannot link or see another's runs", async () => {
  const stranger = await signUp(app, "stranger@example.com");
  await say({ event: "link", success: "e1789600000002-red_to_tray", failed: ["e1789600000001-red_to_tray"] }, stranger);
  const theirs = await (await app.request("/api/episodes/summary", { headers: { Cookie: stranger, Origin: ORIGIN } })).json();
  expect(theirs.episodes).toBe(0);
  // The same id from another account is another run, not a collision.
  expect((await say(run("e1789600000001-red_to_tray", true), stranger)).status).toBe(200);
  expect((await mine("e1789600000001-red_to_tray"))[0].ok).toBe(false);
});

test("what a public client could send to fill or break the table is refused", async () => {
  const refused = async (body: unknown) => (await say(body)).status;
  expect(await refused(null)).toBe(400);
  expect(await refused({ event: "drop table" })).toBe(400);
  expect(await refused(run("not-an-id", true))).toBe(400);
  expect(await refused(run("e1789600000003-x", true, { ticks: { state: [[0]], action: [[0], [1]], poses: [] } }))).toBe(400);
  expect(await refused(run("e1789600000004-x", true, { ticks: { state: [["1"]], action: [[1]], poses: [] } }))).toBe(400);
  expect(await refused(run("e1789600000005-x", true, { ticks: { state: [[Number.NaN]], action: [[1]], poses: [] } }))).toBe(400);
  const long = Array.from({ length: MAX_TICKS + 1 }, () => [0]);
  expect(await refused(run("e1789600000006-x", true, { ticks: { state: long, action: long, poses: [] } }))).toBe(400);

  // Strings are cut to length rather than refused: a long note is still a note.
  expect(await refused(run("e1789600000007-x", false, { note: "x".repeat(5_000), code: "y".repeat(50_000) }))).toBe(200);
  const [row] = await mine("e1789600000007-x");
  expect(row.note).toHaveLength(600);
  expect(row.code).toHaveLength(20_000);
});

test("a session is required", async () => {
  const res = await app.request("/api/episodes", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(run("e1789600000009-x", true)) });
  expect(res.status).toBe(401);
});

test("a robot says the same things with its key, and they are marked as a robot's", async () => {
  const minted = await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "desk arm" }),
  });
  const { key } = await minted.json();
  const post = (body: unknown, auth = `Bearer ${key}`) =>
    app.request("/v1/episodes", { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(body) });

  expect((await post(run("e1789600000020-red_to_tray", true, { backend: "RealRobot" }))).status).toBe(200);
  const [row] = await mine("e1789600000020-red_to_tray");
  expect(row).toMatchObject({ source: "robot", backend: "RealRobot" });
  expect((await post(run("e1789600000021-x", true), "Bearer bx_live_deadbeef")).status).toBe(401);
});

// --- footage -----------------------------------------------------------------

import { episodeBlob } from "../src/app-schema.js";
import { MAX_PART_BYTES, recordBlob } from "../src/episodes.js";

test("a real arm's footage arrives in parts, survives a retry, and needs its episode first", async () => {
  const minted = await app.request("/api/keys", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN }, body: JSON.stringify({ name: "camera arm" }) });
  const { key } = await minted.json();
  const put = (id: string, name: string, part: number, parts: number, body: Uint8Array) =>
    app.request(`/v1/episodes/${id}/blobs/${name}?part=${part}&parts=${parts}`, { method: "PUT", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" }, body: body as unknown as BodyInit });

  const first = new Uint8Array([1, 2, 3, 4]);
  const second = new Uint8Array([5, 6]);
  expect((await put("e1789600000030-film", "front.mp4", 0, 2, first)).status).toBe(404); // no such episode yet

  await app.request("/v1/episodes", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(run("e1789600000030-film", true, { backend: "RealRobot" })) });
  expect(await (await put("e1789600000030-film", "front.mp4", 0, 2, first)).json()).toMatchObject({ ok: true, stored: "database", complete: false });
  expect(await (await put("e1789600000030-film", "front.mp4", 0, 2, first)).json()).toMatchObject({ complete: false }); // the retry is the same part
  expect(await (await put("e1789600000030-film", "front.mp4", 1, 2, second)).json()).toMatchObject({ complete: true });

  const rows = await db.select().from(episodeBlob).where(eq(episodeBlob.episodeId, "e1789600000030-film"));
  expect(rows.map((r) => [r.part, r.size, [...(r.bytes ?? [])]]).sort()).toEqual([[0, 4, [1, 2, 3, 4]], [1, 2, [5, 6]]]);

  expect((await put("e1789600000030-film", "../../etc/passwd", 0, 1, first)).status).toBe(404); // not even a route
  expect((await put("e1789600000030-film", "notes.exe", 0, 1, first)).status).toBe(400);
  expect((await put("e1789600000030-film", "front.mp4", 2, 2, first)).status).toBe(400);
  expect((await put("e1789600000030-film", "front.mp4", 0, 1, new Uint8Array(MAX_PART_BYTES + 1))).status).toBe(413);
});

test("with a bucket configured the bytes go there and only the receipt stays in the database", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  const sent: { url: string; auth: string | null; size: number }[] = [];
  const fakePut = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: new Headers(init.headers).get("Authorization"), size: (init.body as Uint8Array).byteLength });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const result = await recordBlob(db, userId, "e1789600000030-film", "side.mp4", 0, 1, new Uint8Array([9, 9, 9]), fakePut);
    expect(result).toEqual({ ok: true, stored: "supabase", complete: true });
    expect(sent).toEqual([{ url: `https://example.supabase.co/storage/v1/object/episodes/${userId}/e1789600000030-film/side.mp4.000`, auth: "Bearer service-key", size: 3 }]);
    const [row] = await db.select().from(episodeBlob).where(eq(episodeBlob.name, "side.mp4"));
    expect([row.storage, row.bytes, row.size]).toEqual(["supabase", null, 3]);
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});
