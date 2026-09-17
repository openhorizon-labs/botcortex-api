/**
 * Runs kept as training data — the write both doors share, and the read that
 * makes them worth keeping.
 *
 * The runtime's recorder (botcortex/episodes.py) says three things, and says
 * them as they happen:
 *
 *   { event: "episode", episode }        a run ended; here it is
 *   { event: "tag", id, fields }         a fact learned afterwards (its memory record)
 *   { event: "link", success, failed }   this run repaired those
 *
 * A robot says them with its key (POST /v1/episodes); a signed-in browser tab
 * says them with its session (POST /api/episodes). Same write either way, like
 * skill sync — see registry.ts.
 *
 * Everything is best-effort by contract, on both sides: the runtime never lets
 * a failure here touch a run, and this never trusts the runtime's numbers. A
 * tab is a public client, so every string is cut to length, the trajectory is
 * capped, and an account has a daily ceiling: the table is there to be
 * analysed, not to be filled.
 */
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";

import { episode } from "./app-schema.js";
import type { Db } from "./db.js";

export const MAX_TICKS = 6_000; // five minutes at 20 Hz; a skill is seconds
export const MAX_WIDTH = 64; // joints in a state vector; the bimanual arm has 16
export const MAX_OBJECTS = 32;
export const MAX_CODE_CHARS = 20_000;
export const MAX_PER_DAY = 3_000;

export type Source = "robot" | "browser";
type Result = { ok: true; id?: string } | { ok: false; status: 400 | 413 | 429; error: string };

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

const ID = /^e\d{10,16}-[\w.-]{1,80}$/;
const id = (value: unknown): string | null =>
  typeof value === "string" && ID.test(value) ? value : null;

/** A table of finite numbers, `rows` long at most and `width` wide at most. */
function numbers(value: unknown, width: number): number[][] | null {
  if (!Array.isArray(value) || value.length > MAX_TICKS) return null;
  for (const row of value) {
    if (!Array.isArray(row) || row.length > width) return null;
    for (const v of row) if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  return value as number[][];
}

function poses(value: unknown): number[][][] | null {
  if (!Array.isArray(value) || value.length > MAX_TICKS) return null;
  for (const tick of value) if (numbers(tick, 7) === null || (tick as unknown[]).length > MAX_OBJECTS) return null;
  return value as number[][][];
}

const small = (value: unknown, max = 4_000): unknown => {
  const encoded = JSON.stringify(value ?? null);
  return encoded.length <= max ? (value ?? null) : null;
};

async function recordEpisode(db: Db, userId: string, source: Source, raw: unknown): Promise<Result> {
  const e = raw as Record<string, unknown> | null;
  const episodeId = id(e?.id);
  const ticks = e?.ticks as Record<string, unknown> | undefined;
  if (!e || !episodeId || !ticks) return { ok: false, status: 400, error: "not an episode" };

  const state = numbers(ticks.state, MAX_WIDTH);
  const action = numbers(ticks.action, MAX_WIDTH);
  const objectPoses = poses(ticks.poses ?? []);
  if (!state || !action || !objectPoses || state.length === 0 || state.length !== action.length) {
    return { ok: false, status: 400, error: "ticks must be equal-length tables of numbers" };
  }
  if (typeof e.ok !== "boolean" || !text(e.platform, 64)) {
    return { ok: false, status: 400, error: "an episode needs a platform and an outcome" };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ today }] = await db
    .select({ today: count() })
    .from(episode)
    .where(and(eq(episode.userId, userId), gte(episode.createdAt, since)));
  if (today >= MAX_PER_DAY) {
    return { ok: false, status: 429, error: "this account has recorded its episodes for today" };
  }

  const packed = Buffer.from(
    Bun.gzipSync(Buffer.from(JSON.stringify({ state, action, poses: objectPoses }))),
  ).toString("base64");
  const recordedAt = typeof e.ts === "string" ? new Date(e.ts) : null;

  await db
    .insert(episode)
    .values({
      userId,
      id: episodeId,
      source,
      platform: text(e.platform, 64)!,
      backend: text(e.backend, 64) ?? "unknown",
      skill: text(e.skill, 120),
      instruction: text(e.instruction, 2_000),
      phase: text(e.phase, 32),
      executed: e.executed === true,
      ok: e.ok,
      kind: text(e.kind, 64),
      primitive: text(e.primitive, 64),
      note: text(e.note, 600),
      codeSha: text(e.code_sha, 64),
      code: text(e.code, MAX_CODE_CHARS),
      failureId: text(e.failure_id, 160),
      replays: id(e.replays),
      length: state.length,
      fps: typeof e.fps === "number" && e.fps > 0 && e.fps <= 1000 ? Math.round(e.fps) : 20,
      detail: {
        params: small(e.params),
        variation: small(e.variation),
        wobble_deg: typeof e.wobble_deg === "number" ? e.wobble_deg : null,
        names: small(e.names),
        objects: small(e.objects),
        scene_before: small(e.scene_before),
        scene_after: small(e.scene_after),
        moved: text(e.moved, 600),
        version: typeof e.version === "number" ? e.version : null,
      },
      ticksGz: packed,
      recordedAt: recordedAt && !Number.isNaN(recordedAt.getTime()) ? recordedAt : null,
    })
    // The same run said twice (a retry after a timeout) is one run.
    .onConflictDoNothing();
  return { ok: true, id: episodeId };
}

async function linkRepair(db: Db, userId: string, raw: Record<string, unknown>): Promise<Result> {
  const success = id(raw.success);
  const failed = Array.isArray(raw.failed) ? raw.failed.map(id).filter((f): f is string => !!f).slice(0, 50) : [];
  if (!success || failed.length === 0) return { ok: false, status: 400, error: "a link names a success and its failures" };
  // Only a failure that is still waiting: the first repair is the repair.
  await db
    .update(episode)
    .set({ repairedBy: success })
    .where(and(eq(episode.userId, userId), inArray(episode.id, failed), eq(episode.ok, false), sql`${episode.repairedBy} is null`));
  const [row] = await db.select({ repairs: episode.repairs }).from(episode).where(and(eq(episode.userId, userId), eq(episode.id, success)));
  if (row) {
    const repairs = [...new Set([...row.repairs, ...failed])].sort();
    await db.update(episode).set({ repairs }).where(and(eq(episode.userId, userId), eq(episode.id, success)));
  }
  return { ok: true, id: success };
}

async function tag(db: Db, userId: string, raw: Record<string, unknown>): Promise<Result> {
  const episodeId = id(raw.id);
  const fields = raw.fields as Record<string, unknown> | undefined;
  const failureId = text(fields?.failure_id, 160);
  if (!episodeId || !failureId) return { ok: false, status: 400, error: "nothing taggable in that" };
  await db.update(episode).set({ failureId }).where(and(eq(episode.userId, userId), eq(episode.id, episodeId)));
  return { ok: true, id: episodeId };
}

export async function recordEvent(db: Db, userId: string, source: Source, body: unknown): Promise<Result> {
  const raw = body as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { ok: false, status: 400, error: "expected an event" };
  if (raw.event === "episode") return recordEpisode(db, userId, source, raw.episode);
  if (raw.event === "link") return linkRepair(db, userId, raw);
  if (raw.event === "tag") return tag(db, userId, raw);
  return { ok: false, status: 400, error: "unknown event" };
}

/** The trajectory, as the runtime sent it. */
export function unpackTicks(ticksGz: string): { state: number[][]; action: number[][]; poses: number[][][] } {
  return JSON.parse(Buffer.from(Bun.gunzipSync(Buffer.from(ticksGz, "base64"))).toString());
}

/** What an owner's runs add up to: by body and skill, how often each works,
 *  how it fails when it does not, and how many failures found their repair. */
export async function summarise(db: Db, userId: string) {
  const rows = await db
    .select({
      platform: episode.platform,
      skill: episode.skill,
      ok: episode.ok,
      kind: episode.kind,
      repaired: sql<boolean>`${episode.repairedBy} is not null`,
      runs: count(),
    })
    .from(episode)
    .where(eq(episode.userId, userId))
    .groupBy(episode.platform, episode.skill, episode.ok, episode.kind, sql`${episode.repairedBy} is not null`);
  const total = rows.reduce((n, r) => n + r.runs, 0);
  const failed = rows.filter((r) => !r.ok);
  const kinds: Record<string, number> = {};
  for (const r of failed) kinds[r.kind ?? "unknown"] = (kinds[r.kind ?? "unknown"] ?? 0) + r.runs;
  return {
    episodes: total,
    succeeded: total - failed.reduce((n, r) => n + r.runs, 0),
    failed: failed.reduce((n, r) => n + r.runs, 0),
    repaired: failed.filter((r) => r.repaired).reduce((n, r) => n + r.runs, 0),
    failure_kinds: kinds,
    platforms: [...new Set(rows.map((r) => r.platform))].sort(),
    skills: [...new Set(rows.map((r) => r.skill ?? "?"))].sort(),
  };
}
