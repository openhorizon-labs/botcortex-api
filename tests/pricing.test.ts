/**
 * The price table is a billing document. These pin the properties that make
 * it safe to charge from.
 */
import { expect, test } from "bun:test";

import { SIGNUP_GRANT_MICROS, formatMicros, formatMicrosPrecise } from "../src/credits.js";
import {
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  MODELS,
  catalogue,
  costMicros,
  priceFor,
  worstCaseMicros,
} from "../src/pricing.js";

test("every model has a positive price in both directions", () => {
  // A zero would meter to nothing — free inference hiding in a table.
  for (const [id, p] of Object.entries(MODELS)) {
    expect(p.inputPerMTok, `${id} input`).toBeGreaterThan(0);
    expect(p.outputPerMTok, `${id} output`).toBeGreaterThan(0);
    expect(p.label.length, `${id} label`).toBeGreaterThan(0);
    expect(p.family.length, `${id} family`).toBeGreaterThan(0);
  }
});

test("output always costs at least as much as input", () => {
  // True of every vendor's pricing; a row breaking it is a transcription slip.
  for (const [id, p] of Object.entries(MODELS)) {
    expect(p.outputPerMTok, `${id}`).toBeGreaterThanOrEqual(p.inputPerMTok);
  }
});

test("prefix routing sends every id to the right provider", () => {
  // The runtime picks its SDK by name prefix; a mismatch posts an OpenAI model
  // to /v1/messages and yields a baffling 400.
  for (const [id, p] of Object.entries(MODELS)) {
    const looksOpenAI = /^(gpt|o[134])/.test(id);
    expect(looksOpenAI, `${id} -> ${p.provider}`).toBe(p.provider === "openai");
  }
});

test("the documented prices are the ones we charge", () => {
  // Spot-checks against developers.openai.com/api/docs/pricing (2026-08-03),
  // with gpt-5.5 independently confirmed on openai.com.
  expect(costMicros(priceFor("gpt-5.5")!, 1_000_000, 0)).toBe(5_000_000);
  expect(costMicros(priceFor("gpt-5.5")!, 0, 1_000_000)).toBe(30_000_000);
  expect(costMicros(priceFor("gpt-5-nano")!, 1_000_000, 0)).toBe(50_000);
  expect(costMicros(priceFor("gpt-5-nano")!, 0, 1_000_000)).toBe(400_000);
  expect(costMicros(priceFor("gpt-5.6-terra")!, 1_000_000, 1_000_000)).toBe(14_000_000);
});

test("the default model is affordable on the signup grant", () => {
  const needed = worstCaseMicros(priceFor(DEFAULT_MODEL)!);
  expect(Math.floor(SIGNUP_GRANT_MICROS / needed)).toBeGreaterThanOrEqual(10);
});

test("the signup grant covers every model we sell", () => {
  // The point of a six-model lineup: nothing on it is a trap for a new owner.
  // Add a pro-tier row and this fails, which is the warning worth having.
  const onSignup = catalogue(SIGNUP_GRANT_MICROS);
  expect(onSignup.every((m) => m.affordable)).toBe(true);
});

test("a nearly-empty balance flags what it cannot cover, before the 402", () => {
  const nearlyEmpty = catalogue(20_000); // $0.02
  const dearest = nearlyEmpty.find((m) => m.id === "gpt-5.6-sol")!;
  const cheapest = nearlyEmpty.find((m) => m.id === "gpt-5-nano")!;

  expect(dearest.affordable).toBe(false);
  expect(cheapest.affordable).toBe(true);
  expect(dearest.neededMicros).toBeGreaterThan(cheapest.neededMicros * 10);
});

test("every model is tiered and carries a reason to pick it", () => {
  for (const m of catalogue(0)) {
    expect(["top", "fast"]).toContain(m.tier);
    expect(m.note.length).toBeGreaterThan(0);
  }
});

test("an empty balance can afford nothing, and says so for every model", () => {
  expect(catalogue(0).every((m) => !m.affordable)).toBe(true);
});

test("the catalogue covers the allowlist exactly", () => {
  expect(catalogue(0).map((m) => m.id).sort()).toEqual([...ALLOWED_MODELS].sort());
});

test("a balance reads like money — two decimals, always", () => {
  expect(formatMicros(3_000_000)).toBe("$3.00");
  expect(formatMicros(1_250_000)).toBe("$1.25");
  expect(formatMicros(0)).toBe("$0.00");
  // Sub-cent detail rounds away here by design (Sai's call). The cost is
  // real — a teach is ~2000 micros, so this ticks only every fifth one —
  // which is why the precise form exists for anything that would otherwise
  // read as "nothing was charged".
  expect(formatMicros(2_997_827)).toBe("$3.00");
  expect(formatMicros(2_173)).toBe("$0.00");
});

test("the precise form keeps the part that actually moves", () => {
  expect(formatMicrosPrecise(2_997_827)).toBe("$2.9978");
  expect(formatMicrosPrecise(2_173)).toBe("$0.0022");
  // Round amounts still keep the familiar shape.
  expect(formatMicrosPrecise(3_000_000)).toBe("$3.00");
  expect(formatMicrosPrecise(1_250_000)).toBe("$1.25");
  expect(formatMicrosPrecise(0)).toBe("$0.00");
});
