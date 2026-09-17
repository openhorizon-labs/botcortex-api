/**
 * Bring your own model key — held here, never in the browser.
 *
 * An owner who would rather pay OpenAI or Anthropic directly pastes a key once.
 * It is encrypted before it touches the database, decrypted only inside the
 * inference proxy for the length of one call, and never sent back: the app is
 * told which provider it is for and its last four characters, which is enough
 * to recognise it and useless to anyone else.
 *
 * (The first version kept the key in the browser's localStorage and called the
 * provider from the tab. That is a key any script on the page can read, on
 * every device separately, and it needed Anthropic's "dangerous direct browser
 * access" header to work at all.)
 *
 * The owner is asked for the key and nothing else. Which provider it belongs
 * to is read off the key; which model to use is ours to choose well.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";

import { modelKey } from "./app-schema.js";
import type { Db } from "./db.js";
import { cleanSecret } from "./inference.js";
import type { Provider } from "./pricing.js";

export type OwnKey = { provider: Provider; secret: string };
export type OwnKeySummary = { provider: Provider; last4: string; addedAt: number };

/** Which provider a key belongs to, from its shape. Anthropic first: its keys
 *  also begin "sk-". */
export function providerOf(key: string): Provider | null {
  if (/^sk-ant-[A-Za-z0-9_-]{16,}$/.test(key)) return "anthropic";
  if (/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) return "openai";
  return null;
}

// --- encryption at rest ---------------------------------------------------------

/** BYOK_ENCRYPTION_KEY (32 bytes, base64) if set; otherwise derived from the
 *  auth secret, so a deployment that has not set it is still encrypted rather
 *  than refusing to start. Set the dedicated one: then rotating the auth secret
 *  does not orphan every stored key. */
function encryptionKey(): Buffer {
  const dedicated = process.env.BYOK_ENCRYPTION_KEY;
  if (dedicated) {
    const raw = Buffer.from(dedicated, "base64");
    if (raw.length !== 32) throw new Error("BYOK_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    return raw;
  }
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("no BYOK_ENCRYPTION_KEY or BETTER_AUTH_SECRET to encrypt model keys with");
  return Buffer.from(hkdfSync("sha256", secret, "botcortex", "model-key/v1", 32));
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function unseal(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("unrecognised model key envelope");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

// --- asking the provider whether the key is real -----------------------------------

/** Where the Anthropic SDK should point. Tests stand a stub here. */
export function anthropicBaseUrl(): string | undefined {
  const override = process.env.ANTHROPIC_UPSTREAM_URL;
  return override ? override.replace(/\/v1\/messages\/?$/, "") : undefined;
}

export const anthropicClient = (secret: string) => new Anthropic({ apiKey: secret, baseURL: anthropicBaseUrl(), maxRetries: 1 });

/** "rejected" only when the provider itself says the key is no good. If the
 *  provider cannot be reached the key is kept: refusing a good key because of
 *  someone else's outage is worse than finding out on the first teach. */
export async function checkKey(provider: Provider, secret: string): Promise<"ok" | "rejected" | "unverified"> {
  try {
    if (provider === "anthropic") {
      await anthropicClient(secret).models.list({ limit: 1 });
      return "ok";
    }
    const base = (process.env.OPENAI_UPSTREAM_URL ?? "https://api.openai.com/v1/chat/completions").replace(/\/chat\/completions\/?$/, "");
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return "rejected";
    return res.ok ? "ok" : "unverified";
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return "rejected";
    return "unverified";
  }
}

// --- storage ------------------------------------------------------------------------

export type SaveOutcome =
  | { ok: true; key: OwnKeySummary; verified: boolean }
  | { ok: false; status: 400 | 422; error: string };

export async function saveOwnKey(db: Db, userId: string, raw: unknown): Promise<SaveOutcome> {
  const secret = typeof raw === "string" ? cleanSecret(raw) : null;
  const provider = secret ? providerOf(secret) : null;
  if (!secret || !provider) {
    return { ok: false, status: 400, error: "That does not look like an OpenAI or Anthropic API key. They start with sk- or sk-ant-." };
  }
  const verdict = await checkKey(provider, secret);
  if (verdict === "rejected") {
    return { ok: false, status: 422, error: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} rejected that key. Check it was copied whole and has not been revoked.` };
  }
  const now = new Date();
  const row = { provider, ciphertext: seal(secret), last4: secret.slice(-4), updatedAt: now };
  await db.insert(modelKey).values({ userId, ...row, createdAt: now }).onConflictDoUpdate({ target: modelKey.userId, set: { ...row, createdAt: now } });
  return { ok: true, key: { provider, last4: row.last4, addedAt: now.getTime() }, verified: verdict === "ok" };
}

export async function describeOwnKey(db: Db, userId: string): Promise<OwnKeySummary | null> {
  const [row] = await db
    .select({ provider: modelKey.provider, last4: modelKey.last4, createdAt: modelKey.createdAt })
    .from(modelKey)
    .where(eq(modelKey.userId, userId))
    .limit(1);
  return row ? { provider: row.provider as Provider, last4: row.last4, addedAt: row.createdAt.getTime() } : null;
}

/** The key itself. For the inference proxy and nothing else. */
export async function readOwnKey(db: Db, userId: string): Promise<OwnKey | null> {
  const [row] = await db.select({ provider: modelKey.provider, ciphertext: modelKey.ciphertext }).from(modelKey).where(eq(modelKey.userId, userId)).limit(1);
  if (!row) return null;
  try {
    return { provider: row.provider as Provider, secret: unseal(row.ciphertext) };
  } catch {
    // Encrypted under a secret this server no longer has. Treated as absent, so
    // the owner falls back to credit and is asked for the key again, rather than
    // every teach failing with a decryption error they cannot act on.
    return null;
  }
}

export async function removeOwnKey(db: Db, userId: string): Promise<void> {
  await db.delete(modelKey).where(eq(modelKey.userId, userId));
}
