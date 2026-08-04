/**
 * Conversation titles.
 *
 * They are the owner's own first sentence, verbatim. A model used to rewrite
 * them into something tidier; that is what these tests exist to keep out.
 */
import { expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { conversation } from "../src/app-schema.js";

async function thread(text: string) {
  const { app, db } = await makeApp();
  const cookie = await signUp(app, `t${Math.abs(hash(text))}@example.com`);
  const made = await app.request("/api/conversations", {
    method: "POST",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  const { id } = await made.json();
  await app.request("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ id: crypto.randomUUID(), author: "you", text, conversationId: id }),
  });
  const [row] = await db.select().from(conversation).where(eq(conversation.id, id));
  return { app, db, cookie, id, row };
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

test("a task is titled with what the owner actually typed", async () => {
  const { row } = await thread("wave the left arm");
  // Not "move left arm up and down". A paraphrase is not what someone scans
  // the sidebar for, and two different tasks were being paraphrased into the
  // same words — leaving two rows nobody could tell apart.
  expect(row.title).toBe("wave the left arm");
});

test("a long first message is truncated, not rewritten", async () => {
  const long = "pick the red block up off the left tray and set it down gently on the right one";
  const { row } = await thread(long);
  expect(long.startsWith(row.title!)).toBe(true);
  expect(row.title!.length).toBeLessThanOrEqual(60);
});

test("only the owner's first message titles the thread", async () => {
  const { app, cookie, id, db } = await thread("first thing I said");
  await app.request("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      author: "you",
      text: "second thing",
      conversationId: id,
    }),
  });
  const [row] = await db.select().from(conversation).where(eq(conversation.id, id));
  expect(row.title).toBe("first thing I said");
});

test("the robot's reply never takes the title", async () => {
  const { app, cookie, id, db } = await thread("teach it to wave");
  await app.request("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      author: "robot",
      text: "Saved and verified wave_right_arm.",
      conversationId: id,
    }),
  });
  const [row] = await db.select().from(conversation).where(eq(conversation.id, id));
  expect(row.title).toBe("teach it to wave");
});
