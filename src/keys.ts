/**
 * Robot keys — minting, hashing, and lookup.
 *
 * The key travels from the web app to a robot's config file by copy-paste,
 * then authenticates every inference call that robot makes. We store only a
 * SHA-256 hash: the key is 192 bits of CSPRNG output, so there is nothing for
 * an attacker to guess and no reason to make verification expensive.
 */
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "./db.js";
import { robotKey } from "./app-schema.js";

const PREFIX = "bx_live_";
/** Enough of the key to recognise it in a list, not enough to use it. */
const DISPLAY_CHARS = PREFIX.length + 6;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

export async function mintKey(): Promise<{
  raw: string;
  prefix: string;
  hash: string;
}> {
  const raw = PREFIX + hex(crypto.getRandomValues(new Uint8Array(24)));
  return { raw, prefix: raw.slice(0, DISPLAY_CHARS), hash: await sha256(raw) };
}

/**
 * Both SDKs authenticate differently and we sit behind both: the OpenAI
 * client sends `Authorization: Bearer <key>`, the Anthropic client sends
 * `x-api-key`. Accept either so one key works for whichever brain the
 * owner picked.
 */
export function keyFromRequest(headers: Headers): string | null {
  const bearer = headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) return bearer.slice(7).trim();
  return headers.get("x-api-key");
}

export type ResolvedKey = { id: string; userId: string };

/** Returns the owning account for a live key, or null if absent or revoked. */
export async function resolveKey(db: Db, raw: string): Promise<ResolvedKey | null> {
  const [row] = await db
    .select({ id: robotKey.id, userId: robotKey.userId })
    .from(robotKey)
    .where(and(eq(robotKey.hash, await sha256(raw)), isNull(robotKey.revokedAt)))
    .limit(1);
  if (!row) return null;
  // Best-effort touch so the owner can see which robots are actually live.
  db.update(robotKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(robotKey.id, row.id))
    .catch(() => {});
  return row;
}
