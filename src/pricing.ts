/**
 * The model allowlist and what each costs us.
 *
 * This table is the ONLY thing that makes a model reachable through the
 * proxy. An unlisted model is rejected rather than forwarded, because a
 * forwarded-but-unpriced model would meter to zero — free inference that
 * no test catches, since the models under test are always priced.
 *
 * Prices are per MILLION tokens in micro-dollars ($2.00/Mtok = 2_000_000).
 *
 * SOURCE: https://developers.openai.com/api/docs/pricing, read 2026-08-03.
 * Not from memory — this key serves models newer than any training data, and
 * a guessed price in a billing table means charging people the wrong amount.
 * gpt-5.5 was spot-checked against openai.com independently and matched.
 * Re-verify against that page before trusting these with real money.
 *
 * Anthropic prices come from the claude-api skill's model table.
 *
 * We charge these through at cost — no markup — so any later margin decision
 * is a deliberate edit here rather than a hidden one.
 */
export type Provider = "openai" | "anthropic";

export interface ModelPrice {
  provider: Provider;
  inputPerMTok: number;
  outputPerMTok: number;
  /** What the owner sees. These are robot owners, not API consumers. */
  label: string;
  /** Family heading in the picker. */
  family: string;
}

const M = 1_000_000;

export const MODELS: Record<string, ModelPrice> = {
  // ---- OpenAI, current lineup. Dated snapshots (gpt-5.4-2026-03-05), codex
  // variants, and legacy 3.5 are deliberately absent: nobody teaching a robot
  // picks those, and every extra row is another price to keep honest.
  "gpt-5.6-sol": { provider: "openai", inputPerMTok: 5 * M, outputPerMTok: 30 * M, label: "GPT-5.6 Sol", family: "GPT-5.6" },
  "gpt-5.6-terra": { provider: "openai", inputPerMTok: 2 * M, outputPerMTok: 12 * M, label: "GPT-5.6 Terra", family: "GPT-5.6" },
  "gpt-5.6-luna": { provider: "openai", inputPerMTok: 0.2 * M, outputPerMTok: 1.2 * M, label: "GPT-5.6 Luna", family: "GPT-5.6" },

  "gpt-5.5": { provider: "openai", inputPerMTok: 5 * M, outputPerMTok: 30 * M, label: "GPT-5.5", family: "GPT-5.5" },
  "gpt-5.5-pro": { provider: "openai", inputPerMTok: 30 * M, outputPerMTok: 180 * M, label: "GPT-5.5 Pro", family: "GPT-5.5" },

  "gpt-5.4": { provider: "openai", inputPerMTok: 2.5 * M, outputPerMTok: 15 * M, label: "GPT-5.4", family: "GPT-5.4" },
  "gpt-5.4-mini": { provider: "openai", inputPerMTok: 0.75 * M, outputPerMTok: 4.5 * M, label: "GPT-5.4 mini", family: "GPT-5.4" },
  "gpt-5.4-nano": { provider: "openai", inputPerMTok: 0.2 * M, outputPerMTok: 1.25 * M, label: "GPT-5.4 nano", family: "GPT-5.4" },
  "gpt-5.4-pro": { provider: "openai", inputPerMTok: 30 * M, outputPerMTok: 180 * M, label: "GPT-5.4 Pro", family: "GPT-5.4" },

  "gpt-5.2": { provider: "openai", inputPerMTok: 1.75 * M, outputPerMTok: 14 * M, label: "GPT-5.2", family: "GPT-5" },
  "gpt-5.2-pro": { provider: "openai", inputPerMTok: 21 * M, outputPerMTok: 168 * M, label: "GPT-5.2 Pro", family: "GPT-5" },
  "gpt-5.1": { provider: "openai", inputPerMTok: 1.25 * M, outputPerMTok: 10 * M, label: "GPT-5.1", family: "GPT-5" },
  "gpt-5": { provider: "openai", inputPerMTok: 1.25 * M, outputPerMTok: 10 * M, label: "GPT-5", family: "GPT-5" },
  "gpt-5-mini": { provider: "openai", inputPerMTok: 0.25 * M, outputPerMTok: 2 * M, label: "GPT-5 mini", family: "GPT-5" },
  "gpt-5-nano": { provider: "openai", inputPerMTok: 0.05 * M, outputPerMTok: 0.4 * M, label: "GPT-5 nano", family: "GPT-5" },
  "gpt-5-pro": { provider: "openai", inputPerMTok: 15 * M, outputPerMTok: 120 * M, label: "GPT-5 Pro", family: "GPT-5" },

  "gpt-4.1": { provider: "openai", inputPerMTok: 2 * M, outputPerMTok: 8 * M, label: "GPT-4.1", family: "GPT-4" },
  "gpt-4.1-mini": { provider: "openai", inputPerMTok: 0.4 * M, outputPerMTok: 1.6 * M, label: "GPT-4.1 mini", family: "GPT-4" },
  "gpt-4.1-nano": { provider: "openai", inputPerMTok: 0.1 * M, outputPerMTok: 0.4 * M, label: "GPT-4.1 nano", family: "GPT-4" },
  "gpt-4o": { provider: "openai", inputPerMTok: 2.5 * M, outputPerMTok: 10 * M, label: "GPT-4o", family: "GPT-4" },
  "gpt-4o-mini": { provider: "openai", inputPerMTok: 0.15 * M, outputPerMTok: 0.6 * M, label: "GPT-4o mini", family: "GPT-4" },

  "o3": { provider: "openai", inputPerMTok: 2 * M, outputPerMTok: 8 * M, label: "o3", family: "Reasoning (o-series)" },
  "o3-pro": { provider: "openai", inputPerMTok: 20 * M, outputPerMTok: 80 * M, label: "o3-pro", family: "Reasoning (o-series)" },
  "o3-mini": { provider: "openai", inputPerMTok: 1.1 * M, outputPerMTok: 4.4 * M, label: "o3-mini", family: "Reasoning (o-series)" },
  "o4-mini": { provider: "openai", inputPerMTok: 1.1 * M, outputPerMTok: 4.4 * M, label: "o4-mini", family: "Reasoning (o-series)" },
  "o1": { provider: "openai", inputPerMTok: 15 * M, outputPerMTok: 60 * M, label: "o1", family: "Reasoning (o-series)" },
  "o1-pro": { provider: "openai", inputPerMTok: 150 * M, outputPerMTok: 600 * M, label: "o1-pro", family: "Reasoning (o-series)" },

  // ---- Anthropic
  "claude-opus-5": { provider: "anthropic", inputPerMTok: 5 * M, outputPerMTok: 25 * M, label: "Claude Opus 5", family: "Claude" },
  "claude-sonnet-5": { provider: "anthropic", inputPerMTok: 3 * M, outputPerMTok: 15 * M, label: "Claude Sonnet 5", family: "Claude" },
  "claude-haiku-4-5": { provider: "anthropic", inputPerMTok: 1 * M, outputPerMTok: 5 * M, label: "Claude Haiku 4.5", family: "Claude" },
};

/** What a robot teaches with when nobody has chosen otherwise. */
export const DEFAULT_MODEL = "gpt-4.1";

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

/** The picker's data: what it is, what it costs, and whether this balance can
 *  actually afford a teach on it. Answering that here stops an owner picking a
 *  $30/Mtok model and hitting a 402 on their first sentence. */
export function catalogue(balanceMicros: number) {
  return ALLOWED_MODELS.map((id) => {
    const price = MODELS[id];
    const needed = worstCaseMicros(price);
    return {
      id,
      label: price.label,
      family: price.family,
      provider: price.provider,
      inputPerMTok: price.inputPerMTok,
      outputPerMTok: price.outputPerMTok,
      /** Worst case for one call — what the balance is judged against. */
      neededMicros: needed,
      affordable: balanceMicros >= needed,
    };
  });
}
