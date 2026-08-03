/**
 * Metering a streamed response.
 *
 * Usage only shows up at the END of an SSE stream, which is why streaming was
 * refused outright rather than forwarded free. Here we pass every chunk to the
 * client untouched and read the token counts out of the same bytes on the way
 * past, so the client sees no added latency and no call goes uncounted.
 *
 * The two vendors report differently:
 *   OpenAI     one final chunk carrying `usage`, and ONLY when the request
 *              asked for it — see includeUsage below.
 *   Anthropic  `message_start` carries input tokens, then each
 *              `message_delta` carries a running output total.
 *
 * So counts are accumulated with max(), not sum: Anthropic's output figure is
 * cumulative, and adding successive deltas would bill several times over.
 */
import type { Provider } from "./pricing.js";

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * OpenAI omits usage from streams unless asked. Without this the tee reads a
 * whole conversation and finds nothing to bill — the exact silent free path
 * the 400 existed to prevent.
 */
export function includeUsage(body: Record<string, unknown>, provider: Provider) {
  if (provider !== "openai") return body;
  const existing = (body.stream_options ?? {}) as Record<string, unknown>;
  return { ...body, stream_options: { ...existing, include_usage: true } };
}

/** Token counts carried by one SSE event block, if it carries any. */
export function usageFromEvent(block: string, provider: Provider): StreamUsage | null {
  const line = block.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;

  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return null; // a partial or non-JSON frame; the next one will do
  }

  if (provider === "openai") {
    const u = json.usage;
    if (!u) return null;
    return {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
    };
  }

  // message_start nests usage under `message`; message_delta puts it top level.
  const u = json.usage ?? json.message?.usage;
  if (!u) return null;
  return {
    inputTokens:
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
}

/**
 * Mirrors `upstream` to the client while totting up usage, then calls
 * `onFinish` exactly once — including when the client hangs up early, because
 * tokens spent before someone closed a tab were still spent.
 *
 * `estimate` is the backstop for the case that made this free.
 *
 * This stream is PULL-driven: nothing is read from the vendor until the client
 * asks for the next chunk. OpenAI emits `usage` in the very last frame, AFTER
 * the one carrying `finish_reason` — so a client that reads until it has the
 * whole completion and then simply stops reading leaves the usage frame
 * unpulled. Counts stayed at zero, the old `if (total.inputTokens || …)` guard
 * skipped onFinish entirely, and the call was never billed. Repeatable, on a
 * free signup, against our vendor key.
 *
 * So counts are never trusted to arrive: when none did, `estimate` is billed
 * instead, and onFinish always runs so a call can never pass through
 * unrecorded.
 */
export function meteredStream(
  upstream: ReadableStream<Uint8Array>,
  provider: Provider,
  onFinish: (usage: StreamUsage) => void | Promise<void>,
  estimate?: (charsSeen: number) => StreamUsage,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const total: StreamUsage = { inputTokens: 0, outputTokens: 0 };
  let settled = false;
  //: What we actually handed the client, for estimating an aborted stream.
  let charsSeen = 0;

  const absorb = (block: string) => {
    const found = usageFromEvent(block, provider);
    if (!found) return;
    // max(), never +=: Anthropic's output count is cumulative per delta.
    total.inputTokens = Math.max(total.inputTokens, found.inputTokens);
    total.outputTokens = Math.max(total.outputTokens, found.outputTokens);
  };

  const settle = async () => {
    if (settled) return;
    settled = true;
    // No guard on the totals: a call that reached the vendor gets a row
    // whatever happened to the stream. Zero-usage rows are cheap and visible;
    // a missing row is free inference.
    const observed = total.inputTokens || total.outputTokens;
    await onFinish(observed ? total : (estimate?.(charsSeen) ?? total));
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // A stream can end without a trailing blank line.
        if (buffered.trim()) absorb(buffered);
        await settle();
        controller.close();
        return;
      }
      // Client first: metering must never sit between the robot and its bytes.
      controller.enqueue(value);
      charsSeen += value.byteLength;

      buffered += decoder.decode(value, { stream: true });
      let split: number;
      // SSE events are separated by a blank line; chunk boundaries fall
      // wherever TCP feels like, so complete events are drained and the
      // remainder held back rather than parsed half-formed.
      while ((split = buffered.indexOf("\n\n")) !== -1) {
        absorb(buffered.slice(0, split));
        buffered = buffered.slice(split + 2);
      }
    },
    async cancel(reason) {
      await settle();
      await reader.cancel(reason);
    },
  });
}
