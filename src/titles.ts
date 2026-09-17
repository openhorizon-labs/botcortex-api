/**
 * A short title for a task, from the owner's first message.
 *
 * Tried once before, and removed: "wave the left arm" came back as "move left
 * arm up and down" — a paraphrase the owner never wrote, which they could not
 * find by scanning for their own words and which collided with another task
 * paraphrased the same way. What was wrong was the paraphrasing, not the idea:
 * a first message that is a whole paragraph ("Lift the arm high, then bring it
 * back down slowly, then keep the blue block inside…") makes a useless sixty
 * characters of sidebar. So:
 *
 * - A message that is already short IS its title. No model is asked.
 * - A long one is SHORTENED, in the owner's own words, not reworded.
 * - The verbatim title is set first and instantly (routes/account.ts); this
 *   only ever replaces that, and only if the model gives something usable.
 *
 * Paid for the way teaching is: the owner's own key if they have one, else
 * their credit at cost (a few thousandths of a cent on the cheapest model).
 * Never "on us", and never blocking: no credit, no title change.
 */
import { readOwnKey } from "./byok.js";
import { balanceFor, recordUsage } from "./credits.js";
import type { Db } from "./db.js";
import { cleanSecret, tokensFrom, upstreamFor } from "./inference.js";
import { costMicros, priceFor, worstCaseMicros } from "./pricing.js";

export const TITLE_MODEL = "gpt-5-nano";
/** At or under this, the owner's words are the title. */
export const SHORT_ENOUGH = 40;
const MAX_TITLE = 48;

const INSTRUCTIONS =
  "You shorten a robot owner's request into a title for a task list. Use THEIR words: pick the few that " +
  "say what the task is and drop the rest. Do not paraphrase, do not add words they did not use, do not " +
  "describe the request. 3 to 7 words, no quotes, no full stop, sentence case. Reply with the title only.";

/** What the model said, made safe for a sidebar — or null if it is not a title. */
export function tidyTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const line = raw.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const clean = line.replace(/^["'“”‘’`]+|["'“”‘’`.]+$/g, "").replace(/\s+/g, " ").trim();
  if (clean.length < 3 || clean.split(" ").length > 10) return null;
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1).trimEnd()}…` : clean;
}

export async function shortTitle(db: Db, userId: string, text: string): Promise<string | null> {
  if (text.trim().length <= SHORT_ENOUGH) return null;
  const price = priceFor(TITLE_MODEL);
  if (!price) return null;
  const body = {
    model: TITLE_MODEL,
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: text.slice(0, 600) },
    ],
  };

  const own = await readOwnKey(db, userId);
  let secret = own?.provider === "openai" ? own.secret : null;
  const onCredit = secret === null;
  if (onCredit) {
    const balance = await balanceFor(db, userId);
    if (balance.balanceMicros < worstCaseMicros(price, body)) return null;
    secret = cleanSecret(process.env.OPENAI_API_KEY ?? "");
  }
  if (!secret) return null;

  try {
    const res = await fetch(upstreamFor("openai"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const { inputTokens, outputTokens } = tokensFrom(data, "openai");
    await recordUsage(db, {
      userId,
      keyId: null,
      model: TITLE_MODEL,
      inputTokens,
      outputTokens,
      costMicros: onCredit ? costMicros(price, inputTokens, outputTokens) : 0,
    });
    return tidyTitle(data?.choices?.[0]?.message?.content);
  } catch {
    return null;
  }
}
