/**
 * The price table is a billing document. These pin the properties that make
 * it safe to charge from.
 */
import { expect, test } from "bun:test";

import { SIGNUP_GRANT_MICROS } from "../src/credits.js";
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
  expect(costMicros(priceFor("gpt-4.1")!, 1_000_000, 1_000_000)).toBe(10_000_000);
  expect(costMicros(priceFor("gpt-5-nano")!, 1_000_000, 0)).toBe(50_000);
});

test("the default model is affordable on the signup grant", () => {
  const needed = worstCaseMicros(priceFor(DEFAULT_MODEL)!);
  expect(Math.floor(SIGNUP_GRANT_MICROS / needed)).toBeGreaterThanOrEqual(10);
});

test("models the balance cannot cover are flagged, not left to 402", () => {
  // The cliff: gpt-5.5-pro's worst case is near the whole signup grant, so a
  // new owner picking it would be refused on their first sentence. The picker
  // has to be able to say so BEFORE they choose.
  const onSignup = catalogue(SIGNUP_GRANT_MICROS);
  const pro = onSignup.find((m) => m.id === "gpt-5.5-pro")!;
  const cheap = onSignup.find((m) => m.id === DEFAULT_MODEL)!;

  expect(pro.neededMicros).toBeGreaterThan(cheap.neededMicros * 5);
  expect(cheap.affordable).toBe(true);
  expect(onSignup.some((m) => !m.affordable)).toBe(true);
});

test("an empty balance can afford nothing, and says so for every model", () => {
  expect(catalogue(0).every((m) => !m.affordable)).toBe(true);
});

test("the catalogue covers the allowlist exactly", () => {
  expect(catalogue(0).map((m) => m.id).sort()).toEqual([...ALLOWED_MODELS].sort());
});
