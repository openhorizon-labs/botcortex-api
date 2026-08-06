/**
 * Vendor keys as operators actually paste them.
 *
 * Production failed on Aug 6 with "Cannot convert argument to a ByteString"
 * on every teach: OPENAI_API_KEY had been saved in the Vercel dashboard
 * wrapped in curly quotes, and `Bearer “sk-…` crashed Headers.set as an
 * opaque 500. These pin the two behaviours that replace that crash: a key
 * that is merely wrapped or padded WORKS, and a key that genuinely cannot
 * travel in a header comes back as an actionable 503, not a stack trace.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { cleanSecret } from "../src/inference.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let cookie: string;
let server: ReturnType<typeof Bun.serve>;
let seen: Headers | null = null;

beforeAll(async () => {
  ({ app } = await makeApp());
  cookie = await signUp(app, "paster@example.com");
  // Minting a key seeds the signup grant — the call has to clear the balance
  // gate before it ever reaches the vendor-key check.
  await app.request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ name: "grant seed" }),
  });

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen = req.headers;
      await req.json();
      return Response.json({
        id: "chatcmpl_secret_stub",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    },
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.OPENAI_UPSTREAM_URL;
  delete process.env.OPENAI_API_KEY;
});

const chat = () =>
  app.request("/api/inference/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ model: "gpt-5-nano", messages: [{ role: "user", content: "hi" }] }),
  });

test("cleanSecret strips what pasting adds and refuses what it cannot fix", () => {
  expect(cleanSecret("sk-plain")).toBe("sk-plain");
  expect(cleanSecret("  sk-padded\n")).toBe("sk-padded");
  expect(cleanSecret("“sk-curly”")).toBe("sk-curly");
  expect(cleanSecret("'sk-straight'")).toBe("sk-straight");
  expect(cleanSecret("“ sk-both ”")).toBe("sk-both");
  // An interior smart quote is not a wrapper; nothing safe can be recovered.
  expect(cleanSecret("sk-br“ken")).toBeNull();
  expect(cleanSecret("“”")).toBeNull();
});

test("a smart-quoted key still reaches the vendor, unwrapped", async () => {
  process.env.OPENAI_API_KEY = "“sk-wrapped-by-paste”\n";
  const res = await chat();
  expect(res.status).toBe(200);
  expect(seen?.get("authorization")).toBe("Bearer sk-wrapped-by-paste");
});

test("an unusable key is a legible 503, not a ByteString crash", async () => {
  process.env.OPENAI_API_KEY = "sk-br“ken-inside";
  const res = await chat();
  expect(res.status).toBe(503);
  const { error } = await res.json();
  expect(error.type).toBe("api_error");
  expect(error.message).toContain("Re-paste");
});
