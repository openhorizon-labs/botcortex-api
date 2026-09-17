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
import { and, asc, desc, eq } from "drizzle-orm";

import { skill } from "./app-schema.js";
import { user } from "./auth-schema.js";
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
 * its author, with a card on hover).
 *
 * Made ONLY of things the person typed as their name or did in public: never
 * the email, never the account id. The handle is a way to say the name, not an
 * address: two people called Sam are both "@sam", and nothing is looked up by it.
 */
export type SkillAuthor = {
  handle: string;
  name: string;
  /** Milliseconds since the epoch. */
  joinedAt: number;
  /** How many skills they have on the public registry, this one included. */
  skills: number;
  /** The arms those skills were proven on. */
  platforms: string[];
};

/** "Saidev Dhal (Dev)" -> "saidev". The first word of the name, reduced to
 *  what a handle can hold; a name with nothing usable in it is "someone". */
export function handleFor(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const handle = first.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 24);
  return handle || "someone";
}

/** A row on the public registry. The list carries no author; one skill's own
 *  page does. */
export type PublishedSkill = {
  id: string;
  name: string;
  description: string;
  code: string;
  platform: string;
  updatedAt: number;
  author?: SkillAuthor;
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

/** The public registry: every published skill, newest first within an
 *  arm. No account ids, no session — this is the page anyone can read. */
export async function publishedSkills(db: Db, platform?: string): Promise<PublishedSkill[]> {
  const rows = await db
    .select({
      // The row's own id, never the account's: it is what a share link and a
      // per-skill page address, and two owners may both have a "wave".
      id: skill.id,
      name: skill.name,
      description: skill.description,
      code: skill.code,
      platform: skill.platform,
      updatedAt: skill.updatedAt,
    })
    .from(skill)
    .where(platform ? and(eq(skill.published, true), eq(skill.platform, platform)) : eq(skill.published, true))
    .orderBy(asc(skill.platform), desc(skill.updatedAt), asc(skill.name));
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.getTime() }));
}

/** One published skill by id, or null — unpublished and unknown look the
 *  same from outside, on purpose. */
export async function publishedSkill(db: Db, id: string): Promise<PublishedSkill | null> {
  const [row] = await db
    .select({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      code: skill.code,
      platform: skill.platform,
      updatedAt: skill.updatedAt,
      userId: skill.userId,
      authorName: user.name,
      authorSince: user.createdAt,
    })
    .from(skill)
    .innerJoin(user, eq(user.id, skill.userId))
    .where(and(eq(skill.id, id), eq(skill.published, true)))
    .limit(1);
  if (!row) return null;
  const theirs = await db
    .select({ platform: skill.platform })
    .from(skill)
    .where(and(eq(skill.userId, row.userId), eq(skill.published, true)));
  // The account id is read to count with and goes no further than this line.
  const { userId: _userId, authorName, authorSince, ...published } = row;
  return {
    ...published,
    updatedAt: row.updatedAt.getTime(),
    author: {
      handle: handleFor(authorName),
      name: authorName,
      joinedAt: authorSince.getTime(),
      skills: theirs.length,
      platforms: [...new Set(theirs.map((s) => s.platform))].sort(),
    },
  };
}

/** The store's mark_ran, for the registry copy. False when no such row.
 *  A skill seen to run is published in the same stroke: every successful
 *  skill, on any robot, by any owner, is on the public registry unless
 *  its owner takes it down. */
export async function markSkillRan(db: Db, userId: string, platform: string, name: string): Promise<boolean> {
  const rows = await db
    .update(skill)
    .set({ proven: true, published: true })
    .where(and(eq(skill.userId, userId), eq(skill.platform, platform), eq(skill.name, name)))
    // Zero-argument, the way this drizzle types it (see commit 38a3660).
    .returning();
  return rows.length > 0;
}
