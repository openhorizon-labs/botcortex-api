/**
 * Which of an owner's working skills is most like the task in front of the agent.
 *
 * The runtime can answer this by counting shared words, and does when it has to
 * (botcortex/learning.py). Words are a poor proxy once there are many skills:
 * "tidy the bench" shares nothing with put_block_in_tray, which is exactly the
 * skill to start from. So where the network is there, the question is asked by
 * MEANING — one embeddings call for the task and the candidates together — and
 * the runtime is handed back an order. It still holds the skills and still
 * chooses what to show; nothing about a skill is stored here.
 *
 * Paid for like teaching: the owner's own OpenAI key if they have one, else
 * their credit, at cost. No credit, no key, no network: the caller gets null
 * and falls back to words.
 *
 * PRICE SOURCE: https://developers.openai.com/api/docs/pricing, read 2026-09-17
 * — text-embedding-3-small, $0.02 per 1M tokens. Not from memory.
 */
import { readOwnKey } from "./byok.js";
import { balanceFor, recordUsage } from "./credits.js";
import type { Db } from "./db.js";
import { cleanSecret, upstreamFor, type Caller } from "./inference.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
const MICROS_PER_MTOK = 20_000;
export const MAX_CANDIDATES = 200;
const MAX_CHARS = 400;

export type Candidate = { name: string; text: string };
export type Ranked = { name: string; score: number };

const cost = (tokens: number) => Math.ceil((tokens * MICROS_PER_MTOK) / 1_000_000);

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** What was sent, made safe to send: strings, bounded, named. Null if it is not a question. */
export function readQuestion(body: unknown): { query: string; candidates: Candidate[] } | null {
  const { query, candidates } = (body ?? {}) as { query?: unknown; candidates?: unknown };
  if (typeof query !== "string" || !query.trim() || !Array.isArray(candidates)) return null;
  const clean = candidates
    .filter((c): c is Candidate => !!c && typeof c.name === "string" && typeof c.text === "string" && c.name.length > 0)
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ name: c.name.slice(0, 120), text: c.text.slice(0, MAX_CHARS) }));
  return { query: query.trim().slice(0, MAX_CHARS * 2), candidates: clean };
}

export async function rankByMeaning(db: Db, caller: Caller, query: string, candidates: Candidate[]): Promise<Ranked[] | null> {
  if (candidates.length === 0) return [];
  const input = [query, ...candidates.map((c) => c.text || c.name)];

  const own = await readOwnKey(db, caller.userId);
  let secret = own?.provider === "openai" ? own.secret : null;
  const onCredit = secret === null;
  if (onCredit) {
    // Worst case: every character a token. Still fractions of a cent.
    const ceiling = cost(input.reduce((sum, text) => sum + text.length, 0));
    if ((await balanceFor(db, caller.userId)).balanceMicros < ceiling) return null;
    secret = cleanSecret(process.env.OPENAI_API_KEY ?? "");
  }
  if (!secret) return null;

  try {
    const base = upstreamFor("openai").replace(/\/chat\/completions\/?$/, "");
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } };
    const vectors = new Map((data.data ?? []).map((row) => [row.index, row.embedding]));
    const asked = vectors.get(0);
    if (!asked || vectors.size !== input.length) return null;
    const tokens = data.usage?.prompt_tokens ?? 0;
    await recordUsage(db, {
      userId: caller.userId,
      keyId: caller.keyId,
      model: EMBEDDING_MODEL,
      inputTokens: tokens,
      outputTokens: 0,
      costMicros: onCredit ? cost(tokens) : 0,
    });
    return candidates
      .map((candidate, index) => ({ name: candidate.name, score: cosine(asked, vectors.get(index + 1)!) }))
      .sort((a, b) => b.score - a.score);
  } catch {
    return null;
  }
}
