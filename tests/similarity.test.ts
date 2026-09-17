/**
 * Skills ranked by meaning. The point of the test vectors: "tidy the bench"
 * shares no word with put_block_in_tray and must still find it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { cosine, readQuestion } from "../src/similarity.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let cookie: string;
let server: ReturnType<typeof Bun.serve>;
let calls = 0;
let up = true;

// A stand-in for meaning: tidying and putting-away point the same way.
const VECTORS: [RegExp, number[]][] = [
  [/tidy|put|tray|clear|away/i, [1, 0.1, 0]],
  [/wave|nod|greet/i, [0, 1, 0]],
  [/stack|tower|pile/i, [0.2, 0, 1]],
];
const embed = (text: string) => VECTORS.find(([pattern]) => pattern.test(text))?.[1] ?? [0.3, 0.3, 0.3];

beforeAll(async () => {
  ({ app } = await makeApp());
  cookie = await signUp(app, "similar@example.com");
  await app.request("/api/credits", { headers: { Cookie: cookie, Origin: ORIGIN } });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls += 1;
      if (!up) return new Response("down", { status: 503 });
      const { input } = (await req.json()) as { input: string[] };
      return Response.json({ data: input.map((text, index) => ({ index, embedding: embed(text) })), usage: { prompt_tokens: 60 } });
    },
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${server.port}/chat/completions`;
  process.env.OPENAI_API_KEY = "sk-server-side-secret";
});
afterAll(() => {
  server?.stop(true);
  delete process.env.OPENAI_UPSTREAM_URL;
  delete process.env.OPENAI_API_KEY;
});

const ask = (body: unknown, headers: Record<string, string> = { Cookie: cookie }) =>
  app.request("/api/similar", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });

const SKILLS = [
  { name: "wave_hello", text: "wave hello: Wave the arm in greeting." },
  { name: "put_block_in_tray", text: "put block in tray: Pick up a block and put it in a tray." },
  { name: "stack_block", text: "stack block: Stack one block on another." },
];

test("cosine is what it says", () => {
  expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
  expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  expect(cosine([0, 0], [1, 1])).toBe(0);
});

test("a task finds the skill that MEANS the same, with no word in common", async () => {
  const { ranked } = await (await ask({ query: "tidy the bench", candidates: SKILLS })).json();
  expect(ranked.map((r: { name: string }) => r.name)).toEqual(["put_block_in_tray", "stack_block", "wave_hello"]);
  expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
});

test("it costs the owner a sliver, and nothing when there is nothing to rank", async () => {
  const before = (await (await app.request("/api/credits", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()).spentMicros;
  await ask({ query: "make a tower", candidates: SKILLS });
  const after = (await (await app.request("/api/credits", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()).spentMicros;
  expect(after - before).toBeGreaterThan(0);
  expect(after - before).toBeLessThan(10); // 60 tokens at $0.02 per million

  const asked = calls;
  expect(await (await ask({ query: "anything", candidates: [] })).json()).toEqual({ ranked: [] });
  expect(calls).toBe(asked);
});

test("when it cannot say, it says null, and the runtime falls back to words", async () => {
  up = false;
  expect(await (await ask({ query: "tidy the bench", candidates: SKILLS })).json()).toEqual({ ranked: null });
  up = true;
});

test("it is not a way to embed arbitrary text for free, or without signing in", async () => {
  expect((await ask({ query: "", candidates: SKILLS })).status).toBe(400);
  expect((await ask({ query: "x", candidates: SKILLS }, {})).status).toBe(401);
  const question = readQuestion({ query: "q", candidates: Array.from({ length: 500 }, (_, i) => ({ name: `s${i}`, text: "x".repeat(5000) })) })!;
  expect(question.candidates.length).toBe(200);
  expect(question.candidates[0].text.length).toBe(400);
});
