/**
 * AI-generated conversation titles.
 *
 * Driven against a stub so it never bills anyone or depends on a model's mood.
 * The guard is the interesting part: the upgrade must only replace the exact
 * fallback the same writer claimed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { conversation } from "../src/app-schema.js";
import { generateTitle } from "../src/titles.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let cookie: string;
let server: ReturnType<typeof Bun.serve>;
let reply = "Wave the right arm";
let lastBody: any = null;

const realKey = process.env.OPENAI_API_KEY;
const realUpstream = process.env.OPENAI_UPSTREAM_URL;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  cookie = await signUp(app, "titles@example.com");

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastBody = await req.json();
      return Response.json({ choices: [{ message: { content: reply } }] });
    },
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${server.port}`;
  process.env.OPENAI_API_KEY = "sk-ours-not-theirs";
});

afterAll(() => {
  server?.stop(true);
  if (realKey) process.env.OPENAI_API_KEY = realKey;
  else delete process.env.OPENAI_API_KEY;
  if (realUpstream) process.env.OPENAI_UPSTREAM_URL = realUpstream;
  else delete process.env.OPENAI_UPSTREAM_URL;
});

async function threadWith(text: string): Promise<string> {
  const made = await app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({}),
  });
  const { id } = await made.json();
  await app.request("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ id: crypto.randomUUID(), conversationId: id, author: "you", text }),
  });
  return id;
}

const titleOf = async (id: string) =>
  (await db.select().from(conversation).where(eq(conversation.id, id)))[0].title;

test("a generated title replaces the truncation", async () => {
  reply = "Wave the right arm";
  const id = await threadWith("hey can you wave the right arm twice for me please");
  expect(await titleOf(id)).toBe("Wave the right arm");
});

test("it uses a cheap model and a tight budget — we pay for this", async () => {
  await threadWith("fold the towel");
  expect(lastBody.model).toBe("gpt-4o-mini");
  expect(lastBody.max_tokens).toBeLessThanOrEqual(20);
});

test("quotes and trailing punctuation are stripped", async () => {
  reply = '"Sort the blocks."';
  const id = await threadWith("sort the blocks by colour");
  expect(await titleOf(id)).toBe("Sort the blocks");
});

test("an empty or junk reply leaves the fallback alone", async () => {
  reply = "   ";
  const id = await threadWith("pick up the cube and set it down");
  expect(await titleOf(id)).toBe("pick up the cube and set it down".slice(0, 40));
});

test("a long title is bounded", async () => {
  reply = "An extremely verbose title that simply will not stop going on and on";
  const id = await threadWith("do the thing");
  expect((await titleOf(id))!.length).toBeLessThanOrEqual(40);
});

test("the upgrade never clobbers a title that changed underneath it", async () => {
  // The guard: replace only the exact fallback this writer claimed.
  const id = await threadWith("first message here");
  await db.update(conversation).set({ title: "renamed by hand" }).where(eq(conversation.id, id));

  reply = "Something Else Entirely";
  await app.request("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      conversationId: id,
      author: "you",
      text: "second message",
    }),
  });
  expect(await titleOf(id)).toBe("renamed by hand");
});

test("generateTitle declines rather than throwing when unconfigured", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  expect(await generateTitle("anything")).toBeNull();
  process.env.OPENAI_API_KEY = saved;
});
