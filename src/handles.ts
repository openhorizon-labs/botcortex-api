/**
 * Public handles: "@sai".
 *
 * A handle is how a skill page names its author and what an author page is
 * addressed by, so it is unique and it is plain ASCII — it goes in a URL, and
 * a URL someone reads aloud should survive it. The person's NAME is shown
 * beside it, in whatever script they wrote it.
 *
 * Nobody is asked to pick one. The first time an account needs a handle it
 * gets one made from its name ("Saidev Dhal" -> "saidev", then "saidev2" if
 * that is taken), and the owner can change it in settings.
 */
import { eq } from "drizzle-orm";

import { profile } from "./app-schema.js";
import { user } from "./auth-schema.js";
import type { Db } from "./db.js";

export const HANDLE_RULE = /^[a-z0-9_]{3,24}$/;

/** Words a handle may not be: routes, the product, and names that would let
 *  someone pass for us. */
const RESERVED = new Set([
  "admin", "administrator", "api", "app", "auth", "botcortex", "openhorizon", "help", "support",
  "root", "system", "staff", "team", "official", "skills", "signin", "signup", "settings",
  "pricing", "someone", "anonymous", "null", "undefined", "you",
]);

/** "Saidev Dhal (Dev)" -> "saidev". The first word of the name, folded to
 *  ASCII. A name with nothing usable in it ("李 雷", "!!") becomes "maker". */
export function handleFor(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const folded = first.normalize("NFKD").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  return folded.length >= 3 && !RESERVED.has(folded) ? folded : "maker";
}

export type HandleProblem = "invalid" | "reserved" | "taken";

export function handleProblem(handle: string): Exclude<HandleProblem, "taken"> | null {
  if (!HANDLE_RULE.test(handle)) return "invalid";
  if (RESERVED.has(handle)) return "reserved";
  return null;
}

/** This account's handle, made on first need. Safe to call from two requests
 *  at once: the unique index decides, and the loser reads the winner's row. */
export async function ensureHandle(db: Db, userId: string): Promise<string> {
  const [known] = await db.select({ handle: profile.handle }).from(profile).where(eq(profile.userId, userId)).limit(1);
  if (known) return known.handle;
  const [owner] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
  const base = handleFor(owner?.name ?? "");
  for (let n = 1; n <= 200; n += 1) {
    // "maker" is a fallback shared by everyone without a usable name, so it
    // always carries a number.
    const candidate = n === 1 && base !== "maker" ? base : `${base}${n}`;
    await db.insert(profile).values({ userId, handle: candidate }).onConflictDoNothing();
    const [row] = await db.select({ handle: profile.handle }).from(profile).where(eq(profile.userId, userId)).limit(1);
    if (row) return row.handle;
  }
  const fallback = `${base}_${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(profile).values({ userId, handle: fallback }).onConflictDoNothing();
  return fallback;
}

/** Whether `wanted` can be this account's handle: the rule, the reserved
 *  words, and whether someone else has it. Their own current handle is free to
 *  them. The form asks this while they type; setHandle asks again on save,
 *  because a name that was free a second ago is not a promise. */
export async function handleAvailability(db: Db, userId: string, wanted: string): Promise<HandleProblem | null> {
  const handle = wanted.trim().toLowerCase().replace(/^@/, "");
  const problem = handleProblem(handle);
  if (problem) return problem;
  const [holder] = await db.select({ userId: profile.userId }).from(profile).where(eq(profile.handle, handle)).limit(1);
  return holder && holder.userId !== userId ? "taken" : null;
}

export const HANDLE_MESSAGES: Record<HandleProblem, string> = {
  taken: "That username is taken.",
  reserved: "That username is reserved.",
  invalid: "3 to 24 characters: lowercase letters, numbers and underscores.",
};

/** Change it. Null on success. */
export async function setHandle(db: Db, userId: string, wanted: string): Promise<HandleProblem | null> {
  const handle = wanted.trim().toLowerCase().replace(/^@/, "");
  const problem = handleProblem(handle);
  if (problem) return problem;
  const current = await ensureHandle(db, userId);
  if (current === handle) return null;
  const [holder] = await db.select({ userId: profile.userId }).from(profile).where(eq(profile.handle, handle)).limit(1);
  if (holder) return "taken";
  try {
    await db.update(profile).set({ handle, updatedAt: new Date() }).where(eq(profile.userId, userId));
  } catch {
    // Lost a race for it between the check and the write.
    return "taken";
  }
  return null;
}

// --- the rest of a profile -------------------------------------------------------

export const MAX_NAME = 40;
export const MAX_BIO = 160;

/** Generated avatars: DiceBear's robot faces, which suits the subject. The
 *  seed is random and says nothing about the person — it travels to a third
 *  party in a URL, so it must never be an email, a name or an account id. */
export const AVATAR_STYLE = "bottts-neutral";
export const avatarUrl = (seed: string) =>
  `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(seed)}`;
const newSeed = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export type Profile = {
  handle: string;
  firstName: string;
  lastName: string;
  bio: string;
  avatar: string;
  /** False until they have filled the profile step in, or skipped it. */
  onboarded: boolean;
};

/** One line of plain text: no control characters, no runs of whitespace. */
function tidy(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : null;
}

/** "Saidev Dhal (Dev)" -> ["Saidev", "Dhal (Dev)"]: a starting point for the
 *  form, from the name they signed up with. */
export function splitName(name: string): [string, string] {
  const [first = "", ...rest] = name.trim().split(/\s+/);
  return [first.slice(0, MAX_NAME), rest.join(" ").slice(0, MAX_NAME)];
}

export async function readProfile(db: Db, userId: string): Promise<Profile> {
  await ensureHandle(db, userId);
  let [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
  if (!row.avatarSeed) {
    await db.update(profile).set({ avatarSeed: newSeed() }).where(eq(profile.userId, userId));
    [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
  }
  const [owner] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
  const [first, last] = splitName(owner?.name ?? "");
  return {
    handle: row.handle,
    firstName: row.firstName ?? first,
    lastName: row.lastName ?? last,
    bio: row.bio ?? "",
    avatar: avatarUrl(row.avatarSeed!),
    onboarded: row.onboardedAt !== null,
  };
}

export type ProfileChange = {
  handle?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  bio?: unknown;
  /** True asks for a different generated avatar. */
  shuffleAvatar?: unknown;
  /** True records that the profile step is done (filled in or skipped). */
  done?: unknown;
};

export type ProfileProblem = { field: "handle" | "firstName" | "lastName" | "bio"; code: string; error: string };

/** Apply what was sent; leave the rest. Null on success. */
export async function updateProfile(db: Db, userId: string, change: ProfileChange): Promise<ProfileProblem | null> {
  await readProfile(db, userId);
  const set: Partial<typeof profile.$inferInsert> = {};
  if (change.firstName !== undefined) {
    const first = tidy(change.firstName, MAX_NAME);
    if (!first) return { field: "firstName", code: "invalid", error: `A first name, up to ${MAX_NAME} characters.` };
    set.firstName = first;
  }
  if (change.lastName !== undefined) {
    const last = tidy(change.lastName, MAX_NAME);
    if (last === null) return { field: "lastName", code: "invalid", error: `Up to ${MAX_NAME} characters.` };
    set.lastName = last;
  }
  if (change.bio !== undefined) {
    const bio = tidy(change.bio, MAX_BIO);
    if (bio === null) return { field: "bio", code: "invalid", error: `Up to ${MAX_BIO} characters.` };
    set.bio = bio;
  }
  if (change.handle !== undefined) {
    if (typeof change.handle !== "string") return { field: "handle", code: "invalid", error: "A handle is text." };
    const problem = await setHandle(db, userId, change.handle);
    if (problem) {
      return { field: "handle", code: problem, error: HANDLE_MESSAGES[problem] };
    }
  }
  if (change.shuffleAvatar === true) set.avatarSeed = newSeed();
  if (change.done === true) set.onboardedAt = new Date();
  if (Object.keys(set).length > 0) {
    await db.update(profile).set({ ...set, updatedAt: new Date() }).where(eq(profile.userId, userId));
  }
  // The account's own name follows the public one, so the app's sidebar and
  // the skill page never disagree about what this person is called.
  if (set.firstName !== undefined || set.lastName !== undefined) {
    const [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
    const full = [row.firstName, row.lastName].filter(Boolean).join(" ");
    if (full) await db.update(user).set({ name: full }).where(eq(user.id, userId));
  }
  return null;
}
