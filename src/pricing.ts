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
  /** Which icon the picker draws. */
  tier: "top" | "fast";
  /** One line on why an owner would pick it. */
  note: string;
}

const M = 1_000_000;

export const MODELS: Record<string, ModelPrice> = {
  // Six, not twenty-seven. A robot owner picking a brain wants "best" or
  // "cheap", not a catalogue — and every extra row is another price we have to
  // keep honest against OpenAI's page.
  //
  // GPT only. Claude is deliberately absent: BYO-key users reach Anthropic
  // directly without touching this table, so pricing it here would only sell
  // something nobody asked us to sell. Re-adding it is one row.
  "gpt-5.6-sol": {
    provider: "openai", inputPerMTok: 5 * M, outputPerMTok: 30 * M,
    label: "GPT-5.6 Sol", family: "Most capable", tier: "top",
    note: "Best at hard, multi-step tasks",
  },
  "gpt-5.5": {
    provider: "openai", inputPerMTok: 5 * M, outputPerMTok: 30 * M,
    label: "GPT-5.5", family: "Most capable", tier: "top",
    note: "Proven flagship",
  },
  "gpt-5.6-terra": {
    provider: "openai", inputPerMTok: 2 * M, outputPerMTok: 12 * M,
    label: "GPT-5.6 Terra", family: "Most capable", tier: "top",
    note: "Strong, less costly",
  },

  "gpt-5.6-luna": {
    provider: "openai", inputPerMTok: 0.2 * M, outputPerMTok: 1.2 * M,
    label: "GPT-5.6 Luna", family: "Fast and cheap", tier: "fast",
    note: "Newest generation, low cost",
  },
  "gpt-5-mini": {
    provider: "openai", inputPerMTok: 0.25 * M, outputPerMTok: 2 * M,
    label: "GPT-5 mini", family: "Fast and cheap", tier: "fast",
    note: "Reliable everyday choice",
  },
  "gpt-5-nano": {
    provider: "openai", inputPerMTok: 0.05 * M, outputPerMTok: 0.4 * M,
    label: "GPT-5 nano", family: "Fast and cheap", tier: "fast",
    note: "Cheapest that still teaches well",
  },
};

/** What a robot teaches with when nobody has chosen otherwise. */
// Cheap enough that a $2 grant buys plenty of teaching, current enough to
// write good skills. Verified authoring end-to-end on this family.
export const DEFAULT_MODEL = "gpt-5.6-luna";

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
      tier: price.tier,
      note: price.note,
      provider: price.provider,
      inputPerMTok: price.inputPerMTok,
      outputPerMTok: price.outputPerMTok,
      /** Worst case for one call — what the balance is judged against. */
      neededMicros: needed,
      affordable: balanceMicros >= needed,
    };
  });
}
