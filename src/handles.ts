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
