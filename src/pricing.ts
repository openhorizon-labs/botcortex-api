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
