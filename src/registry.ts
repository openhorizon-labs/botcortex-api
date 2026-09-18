/**
 * The skill registry's reads and writes, shared by its two doors — a robot
 * key (POST /v1/skills) and the web session the browser sim teaches under
 * (POST /api/skills). Extracted the way inference.ts was and for the same
 * reason: a skill taught in the browser must land in the registry EXACTLY
 * the way a robot's does, or "teach in the browser today, pair a real arm
 * later, the skills are waiting" quietly becomes two subtly different
 * registries.
 *
 * The registry is also where a skill SURVIVES: the browser sim reads its
 * account's rows back at boot (GET /api/skills) and rebuilds its local
 * store from them when the browser's own copy is gone.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { profile, skill, skillRun } from "./app-schema.js";
import { user } from "./auth-schema.js";
import { ensureHandle, readProfile } from "./handles.js";
import type { Db } from "./db.js";

/** Roughly a long authored skill plus its metadata. */
export const MAX_SKILL_CHARS = 24_000;

/** Where a skill with no stated body is filed. */
export const UNKNOWN_PLATFORM = "unknown";

export type SkillUpsert =
  | { ok: true; name: string }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Who taught a skill, as the public sees them (Sai, Sep 17: a skill page names
 * its author, with a card on hover and a page behind it).
 *
 * Made ONLY of things the person typed as their name or did in public: never
 * the email, never the account id. The handle is unique — see handles.ts.
 */
export type SkillAuthor = {
  handle: string;
  name: string;
  /** A line about them, in their words. Empty until they write one. */
  bio: string;
  /** A generated avatar's URL. */
  avatar: string;
  /** Milliseconds since the epoch. */
  joinedAt: number;
  /** How many skills they have on the public registry. */
  skills: number;
  /** The arms those skills were proven on. */
  platforms: string[];
  /** Times someone else has run one of their skills. */
  runs: number;
};

/** A row on the public registry. In a list the author is a handle; on the
 *  skill's own page it is the whole card. */
export type PublishedSkill = {
  id: string;
  name: string;
  description: string;
  code: string;
  platform: string;
  updatedAt: number;
  /** Times someone other than the author has run it — what the list is
   *  ranked by. */
  runs: number;
  author: { handle: string } | SkillAuthor;
};

export async function upsertSkill(db: Db, userId: string, body: unknown): Promise<SkillUpsert> {
  const { name, description, code, platform, proven } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || typeof code !== "string" || typeof description !== "string") {
    return { ok: false, status: 400, error: "name, description and code are required" };
  }
  if (name.length + description.length + code.length > MAX_SKILL_CHARS) {
    return { ok: false, status: 413, error: "skill too large" };
  }

  const now = new Date();
  // New code is unproven code, exactly as in the store: saving over a skill
  // that had run drops the mark, unless the sender is carrying a copy that
  // it saw run (the browser pushing up a proven local skill the registry
  // never received).
  const ran = proven === true;
  await db
    .insert(skill)
    .values({
      id: crypto.randomUUID(),
      userId,
      name,
      description,
      code,
      platform: typeof platform === "string" && platform ? platform : UNKNOWN_PLATFORM,
      proven: ran,
      published: ran,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [skill.userId, skill.platform, skill.name],
      // The registry lists what has run, by default (Sai, Sep 16): a copy
      // arriving proven is published; new code is unproven and comes down
      // until it has run again, when the proof mark puts it back up.
      set: { description, code, proven: ran, updatedAt: now, published: ran },
    });

  return { ok: true, name };
}

/** What a boot reads back: everything needed to rebuild a local store. */
export type SkillRow = {
  id: string;
  name: string;
  description: string;
  code: string;
  platform: string;
  proven: boolean;
  published: boolean;
  /** Milliseconds since the epoch — the store compares it with a local
   *  file's mtime to decide which copy is newer. */
  updatedAt: number;
};

export async function listSkills(db: Db, userId: string, platform?: string): Promise<SkillRow[]> {
  const rows = await db
    .select({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      code: skill.code,
      platform: skill.platform,
      proven: skill.proven,
      published: skill.published,
      updatedAt: skill.updatedAt,
    })
    .from(skill)
    .where(platform ? and(eq(skill.userId, userId), eq(skill.platform, platform)) : eq(skill.userId, userId))
    .orderBy(asc(skill.name));
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.getTime() }));
}

export type PublishOutcome = "published" | "unpublished" | "missing" | "unproven";

/** Put a skill back on the public registry, or take it down. Publishing
 *  is automatic on the first successful run; this is the owner's override
 *  either way. Only a proven skill can go up: "successful" is the
 *  registry's one promise. */
export async function setPublished(
  db: Db,
  userId: string,
  platform: string,
  name: string,
  published: boolean,
): Promise<PublishOutcome> {
  const where = and(eq(skill.userId, userId), eq(skill.platform, platform), eq(skill.name, name));
  const [row] = await db.select({ proven: skill.proven }).from(skill).where(where).limit(1);
  if (!row) return "missing";
  if (published && !row.proven) return "unproven";
  await db.update(skill).set({ published }).where(where);
  return published ? "published" : "unpublished";
}

const PUBLIC_COLUMNS = {
  // The row's own id, never the account's: it is what a share link and a
  // per-skill page address, and two owners may both have a "wave".
  id: skill.id,
  name: skill.name,
  description: skill.description,
  code: skill.code,
  platform: skill.platform,
  updatedAt: skill.updatedAt,
  userId: skill.userId,
};

type Row = { id: string; name: string; description: string; code: string; platform: string; updatedAt: Date; userId: string };

async function runCounts(db: Db, skillIds: string[]): Promise<Map<string, number>> {
  if (skillIds.length === 0) return new Map();
  const rows = await db
    .select({ skillId: skillRun.skillId, runs: sql<number>`count(*)::int` })
    .from(skillRun)
    .where(inArray(skillRun.skillId, skillIds))
    .groupBy(skillRun.skillId);
  return new Map(rows.map((row) => [row.skillId, Number(row.runs)]));
}

/** Rows as the public sees them. The account id is read to find the handle
 *  and goes no further than this function. */
async function published(db: Db, rows: Row[]): Promise<PublishedSkill[]> {
  const runs = await runCounts(db, rows.map((row) => row.id));
  const handles = new Map<string, string>();
  for (const userId of new Set(rows.map((row) => row.userId))) handles.set(userId, await ensureHandle(db, userId));
  return rows.map(({ userId, updatedAt, ...row }) => ({
    ...row,
    updatedAt: updatedAt.getTime(),
    runs: runs.get(row.id) ?? 0,
    author: { handle: handles.get(userId)! },
  }));
}

/** Ranked the way the registry is worth reading: what other people keep
 *  running first, then the newest. Recency alone put every half-idea a
 *  beginner had just proven above the skill fifty strangers had run. */
function ranked(skills: PublishedSkill[]): PublishedSkill[] {
  return [...skills].sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) || b.runs - a.runs || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name),
  );
}

/** The public registry: every published skill, best first within an arm. No
 *  account ids, no session — this is the page anyone can read. */
export async function publishedSkills(db: Db, platform?: string): Promise<PublishedSkill[]> {
  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(skill)
    .where(platform ? and(eq(skill.published, true), eq(skill.platform, platform)) : eq(skill.published, true))
    .orderBy(asc(skill.platform), desc(skill.updatedAt), asc(skill.name));
  return ranked(await published(db, rows));
}

async function authorCard(db: Db, userId: string, theirs: PublishedSkill[]): Promise<SkillAuthor | null> {
  const [owner] = await db.select({ name: user.name, since: user.createdAt }).from(user).where(eq(user.id, userId)).limit(1);
  if (!owner) return null;
  const about = await readProfile(db, userId);
  return {
    handle: about.handle,
    // Sign-up no longer asks for a name (the profile step does), so an account
    // that skipped that step has none. It still gets a word, not a blank.
    name: [about.firstName, about.lastName].filter(Boolean).join(" ") || owner.name || "Maker",
    bio: about.bio,
    avatar: about.avatar,
    joinedAt: owner.since.getTime(),
    skills: theirs.length,
    platforms: [...new Set(theirs.map((s) => s.platform))].sort(),
    runs: theirs.reduce((sum, s) => sum + s.runs, 0),
  };
}

async function publishedBy(db: Db, userId: string): Promise<PublishedSkill[]> {
  const rows = await db.select(PUBLIC_COLUMNS).from(skill).where(and(eq(skill.userId, userId), eq(skill.published, true)));
  return ranked(await published(db, rows));
}

/** One published skill by id, with its author's card, or null — unpublished
 *  and unknown look the same from outside, on purpose. */
export async function publishedSkill(db: Db, id: string): Promise<PublishedSkill | null> {
  const [row] = await db.select(PUBLIC_COLUMNS).from(skill).where(and(eq(skill.id, id), eq(skill.published, true))).limit(1);
  if (!row) return null;
  const theirs = await publishedBy(db, row.userId);
  const author = await authorCard(db, row.userId, theirs);
  const mine = theirs.find((s) => s.id === id);
  return mine && author ? { ...mine, author } : null;
}

/** An author's public page: their card and what they have published. Null
 *  for an unknown handle AND for an account that has published nothing — a
 *  person who only signed up has no public page. */
export async function publishedAuthor(
  db: Db,
  handle: string,
): Promise<{ author: SkillAuthor; skills: PublishedSkill[] } | null> {
  const [owner] = await db.select({ userId: profile.userId }).from(profile).where(eq(profile.handle, handle.toLowerCase())).limit(1);
  if (!owner) return null;
  const skills = await publishedBy(db, owner.userId);
  if (skills.length === 0) return null;
  const author = await authorCard(db, owner.userId, skills);
  return author ? { author, skills } : null;
}

/**
 * Someone ran a published skill. Counted once per skill, visitor and day, and
 * never for the author — a registry ranked by its authors' own reloads is
 * ranked by nothing. False when there is no such published skill.
 */
export async function countRun(
  db: Db,
  id: string,
  visitor: string,
  day: string,
  viewerId: string | null,
  dailyCap = Number.POSITIVE_INFINITY,
): Promise<{ counted: boolean; runs: number } | null> {
  const [row] = await db.select({ userId: skill.userId }).from(skill).where(and(eq(skill.id, id), eq(skill.published, true))).limit(1);
  if (!row) return null;
  let counted = false;
  // One address cannot vote for the whole registry in a day.
  const [{ spent }] = await db
    .select({ spent: sql<number>`count(*)::int` })
    .from(skillRun)
    .where(and(eq(skillRun.visitor, visitor), eq(skillRun.day, day)));
  if (row.userId !== viewerId && Number(spent) < dailyCap) {
    const inserted = await db.insert(skillRun).values({ skillId: id, visitor, day }).onConflictDoNothing().returning();
    counted = inserted.length > 0;
  }
  return { counted, runs: (await runCounts(db, [id])).get(id) ?? 0 };
}

/** The store's mark_ran, for the registry copy. False when no such row.
 *  A skill seen to run is published in the same stroke: every successful
 *  skill, on any robot, by any owner, is on the public registry unless
 *  its owner takes it down. */
export type ForgetOutcome = "deleted" | "missing" | "published";

/** The owner deleting a draft from the sidebar. Only a skill that has never
 *  been seen to work can go: a proven one is on the public registry, and
 *  taking one down is the paid capability setPublished already refuses — a
 *  delete that got around that would be the same withdrawal under another
 *  name. Same rule as the runtime's RobotSession.forget_skill. */
export async function forgetSkill(db: Db, userId: string, platform: string, name: string): Promise<ForgetOutcome> {
  const where = and(eq(skill.userId, userId), eq(skill.platform, platform), eq(skill.name, name));
  const [row] = await db.select({ proven: skill.proven, published: skill.published }).from(skill).where(where).limit(1);
  if (!row) return "missing";
  if (row.proven || row.published) return "published";
  await db.delete(skill).where(where);
  return "deleted";
}

export async function markSkillRan(db: Db, userId: string, platform: string, name: string): Promise<boolean> {
  const rows = await db
    .update(skill)
    .set({ proven: true, published: true })
    .where(and(eq(skill.userId, userId), eq(skill.platform, platform), eq(skill.name, name)))
    // Zero-argument, the way this drizzle types it (see commit 38a3660).
    .returning();
  return rows.length > 0;
}
