/**
 * The model allowlist and what each costs us.
 *
 * This table is the ONLY thing that makes a model reachable through the
 * proxy. An unlisted model is rejected rather than forwarded, because a
 * forwarded-but-unpriced model would meter to zero — free inference that
 * no test catches, since the models under test are always priced.
 *
 * Prices are per MILLION tokens in micro-dollars ($2.00/Mtok = 2_000_000),
 * quoted at list from each vendor's public pricing as of 2026-08-03. We
 * charge these through at cost for the credit preview — no markup — so any
 * later margin decision is a deliberate edit here rather than a hidden one.
 */
export type Provider = "openai" | "anthropic";

export interface ModelPrice {
  provider: Provider;
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODELS: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4.1": { provider: "openai", inputPerMTok: 2_000_000, outputPerMTok: 8_000_000 },
  "gpt-4.1-mini": { provider: "openai", inputPerMTok: 400_000, outputPerMTok: 1_600_000 },
  "gpt-4o": { provider: "openai", inputPerMTok: 2_500_000, outputPerMTok: 10_000_000 },
  "gpt-4o-mini": { provider: "openai", inputPerMTok: 150_000, outputPerMTok: 600_000 },

  // Anthropic
  "claude-opus-5": { provider: "anthropic", inputPerMTok: 5_000_000, outputPerMTok: 25_000_000 },
  "claude-sonnet-5": { provider: "anthropic", inputPerMTok: 3_000_000, outputPerMTok: 15_000_000 },
  "claude-haiku-4-5": { provider: "anthropic", inputPerMTok: 1_000_000, outputPerMTok: 5_000_000 },
};

export function priceFor(model: string): ModelPrice | undefined {
  return MODELS[model];
}

/** Micro-dollars for a completed call. Rounded up: never undercharge by a
 *  fraction, never surprise an owner with a rounding-driven overage either. */
export function costMicros(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return Math.ceil(
    (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000,
  );
}

export const ALLOWED_MODELS = Object.keys(MODELS);

/**
 * What a single call could cost at worst, used as a floor guard before we
 * forward anything.
 *
 * The old check was `balance > 0`, which let an account holding a hundredth of
 * a cent start a call that could cost dollars. Token counts are unknowable
 * until the response comes back, so these are deliberate assumed ceilings, not
 * accounting: a request that names `max_tokens` is trusted for the output half.
 *
 * The trade is that the last fraction of a balance becomes unspendable. That
 * beats letting an owner finish meaningfully negative.
 */
// Sized against what the authoring agent actually sends — measured teach calls
// run ~1.5-2k input and tens of output tokens — with roughly 10x headroom. Too
// generous a ceiling is not "safer": it strands usable credit and refuses work
// an owner has the balance for.
const ASSUMED_MAX_INPUT_TOKENS = 16_000;
const ASSUMED_MAX_OUTPUT_TOKENS = 8_000;

export function worstCaseMicros(price: ModelPrice, maxTokens?: unknown): number {
  const output =
    typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
      ? maxTokens
      : ASSUMED_MAX_OUTPUT_TOKENS;
  return costMicros(price, ASSUMED_MAX_INPUT_TOKENS, output);
}
