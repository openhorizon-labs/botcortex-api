/**
 * Naming a conversation.
 *
 * "wave the right arm, but slower this ti" is a truncation, not a title. This
 * asks a small model for a real one.
 *
 * On OUR key and OUR cost, deliberately: it is never recorded in `usage`, so
 * it can never touch an owner's credit. Naming their own conversations is not
 * something a customer should pay for, and at a few dozen tokens on the
 * cheapest model it rounds to nothing for us.
 */

const MODEL = "gpt-4o-mini";

/** Awaited, not fired-and-forgotten: on serverless, work left pending after
 *  the response is sent gets killed — it would pass locally and silently
 *  never run in production. This only delays the FIRST message of a thread,
 *  which the client has already rendered optimistically. */
const TIMEOUT_MS = 4000;
const MAX_TITLE = 40;

const SYSTEM = `You name tasks given to a robot. Reply with a title of 2-5 words, \
plain words, no quotes, no trailing punctuation, no markdown. Describe the task, \
do not restate it verbatim. If the message is not a task, reply with a short \
neutral topic instead.`;

/** A real title, or null to keep whatever fallback the caller already stored. */
export async function generateTitle(text: string): Promise<string | null> {
  const secret = process.env.OPENAI_API_KEY;
  if (!secret) return null;

  const endpoint =
    process.env.OPENAI_UPSTREAM_URL || "https://api.openai.com/v1/chat/completions";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 20,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text.slice(0, 500) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;

    // Models like to wrap titles in quotes and end them with a full stop.
    const cleaned = raw.trim().replace(/^["'`]|["'`]$/g, "").replace(/[.!]$/, "").trim();
    if (!cleaned) return null;
    return cleaned.slice(0, MAX_TITLE);
  } catch {
    // Timeout, network, or a malformed reply — the truncation already stored
    // is a perfectly serviceable title.
    return null;
  }
}
