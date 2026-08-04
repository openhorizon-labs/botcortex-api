/**
 * Conversations and their transcripts.
 *
 * The failure this replaces: a single rolling list where "New task" DELETED
 * everything. Threads exist so starting fresh is additive.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { ORIGIN, makeApp, signUp } from "./harness.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let cookie: string;

const json = (path: string, body: unknown, as: string, method = "POST") =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: as },
    body: JSON.stringify(body),
  });

async function newConversation(as = cookie): Promise<string> {
  const res = await json("/api/conversations", {}, as);
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

const say = (conversationId: string, author: string, text: string, as = cookie) =>
  json("/api/messages", { id: crypto.randomUUID(), conversationId, author, text }, as);

const listConversations = async (as = cookie) =>
  (await (await app.request("/api/conversations", { headers: { Cookie: as, Origin: ORIGIN } })).json())
    .conversations as { id: string; title: string | null; messages: number }[];

const readMessages = async (id: string, as = cookie) =>
  (await (
    await app.request(`/api/messages?conversation=${id}`, { headers: { Cookie: as, Origin: ORIGIN } })
  ).json()).messages as { author: string; text: string }[];

// Bun auto-loads .env, so without this the suite makes REAL OpenAI calls:
// slow, billed, and non-deterministic. With no key, title generation declines
// and the truncation stands — which is exactly the fallback worth pinning here.
// The AI path has its own file, against a stub.
const realKey = process.env.OPENAI_API_KEY;
beforeAll(async () => {
  delete process.env.OPENAI_API_KEY;
  ({ app } = await makeApp());
  cookie = await signUp(app, "threads@example.com");
});
afterAll(() => {
  if (realKey) process.env.OPENAI_API_KEY = realKey;
});

test("starting a new task keeps the old one — the whole point", async () => {
  const a = await newConversation();
  await say(a, "you", "wave the right arm");
  await say(a, "robot", "Done.");

  const b = await newConversation();
  await say(b, "you", "fold the towel");

  const threads = await listConversations();
  expect(threads).toHaveLength(2);
  // Both survive, and the older one still has everything it had.
  expect(await readMessages(a)).toHaveLength(2);
  expect((await readMessages(a)).map((m) => m.text)).toEqual(["wave the right arm", "Done."]);
  expect((await readMessages(b)).map((m) => m.text)).toEqual(["fold the towel"]);
});

test("the title is the owner's first sentence, truncated but never rewritten", async () => {
  const id = await newConversation();
  await say(id, "you", "sort the red parts into the left bin, gently and slowly please");
  await say(id, "you", "actually make it faster");

  const [thread] = (await listConversations()).filter((t) => t.id === id);
  expect(thread.title).toBe("sort the red parts into the left bin, gently and slowly plea");
  expect(thread.title!.length).toBeLessThanOrEqual(60);
});

test("a robot speaking first does not title the thread", async () => {
  const id = await newConversation();
  await say(id, "robot", "Connected.");
  expect((await listConversations()).find((t) => t.id === id)!.title).toBeNull();
});

test("empty conversations stay out of the sidebar", async () => {
  const before = (await listConversations()).length;
  await newConversation();
  expect((await listConversations()).length).toBe(before);
});

test("most recently active sorts first", async () => {
  const older = await newConversation();
  await say(older, "you", "older thread");
  const newer = await newConversation();
  await say(newer, "you", "newer thread");

  await say(older, "you", "bumped");
  expect((await listConversations())[0].id).toBe(older);
});

test("threads are per-owner", async () => {
  const other = await signUp(app, "nosy@example.com");
  const mine = await newConversation();
  await say(mine, "you", "private");

  expect((await listConversations(other)).some((t) => t.id === mine)).toBe(false);
  // Reading someone else's thread by id yields nothing, not their transcript.
  expect(await readMessages(mine, other)).toHaveLength(0);
  // And writing into it is refused outright.
  expect((await say(mine, "you", "injected", other)).status).toBe(404);
});

test("deleting one thread leaves the others alone", async () => {
  const keep = await newConversation();
  await say(keep, "you", "keep me");
  const drop = await newConversation();
  await say(drop, "you", "drop me");

  const gone = await app.request(`/api/conversations/${drop}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  expect(gone.status).toBe(200);

  const ids = (await listConversations()).map((t) => t.id);
  expect(ids).toContain(keep);
  expect(ids).not.toContain(drop);
  expect(await readMessages(keep)).toHaveLength(1);
});

test("one owner cannot delete another's thread", async () => {
  const other = await signUp(app, "vandal@example.com");
  const mine = await newConversation();
  await say(mine, "you", "still here");

  const attempt = await app.request(`/api/conversations/${mine}`, {
    method: "DELETE",
    headers: { Cookie: other, Origin: ORIGIN },
  });
  expect(attempt.status).toBe(404);
  expect(await readMessages(mine)).toHaveLength(1);
});

test("re-posting the same message id does not duplicate it", async () => {
  const id = await newConversation();
  const messageId = crypto.randomUUID();
  const body = { id: messageId, conversationId: id, author: "you", text: "once" };
  await json("/api/messages", body, cookie);
  await json("/api/messages", body, cookie);
  expect(await readMessages(id)).toHaveLength(1);
});

test("history needs a session", async () => {
  expect((await app.request("/api/conversations")).status).toBe(401);
  expect((await app.request("/api/messages?conversation=x")).status).toBe(401);
});

test("a robot reply cannot blank the title the owner's message just set", async () => {
  // Both posts race in the real app: the user types, the robot answers, and a
  // read-modify-write on the title let whichever landed last win.
  const id = await newConversation();
  await Promise.all([
    say(id, "you", "pick up the blue cube"),
    say(id, "robot", "Working on it."),
    say(id, "robot", "Done."),
  ]);
  const thread = (await listConversations()).find((t) => t.id === id)!;
  expect(thread.title).toBe("pick up the blue cube");
});

test("a tool call is stored in the transcript, in order, with its detail", async () => {
  const id = await newConversation();
  await say(id, "you", "teach it to wave");
  await json("/api/messages", {
    id: crypto.randomUUID(),
    conversationId: id,
    author: "robot",
    kind: "tool",
    text: 'Writing "wave_right_arm"',
    payload: {
      name: "save_skill",
      input: { name: "wave_right_arm", code: "META = {...}\ndef run(ctx): pass" },
      result: "saved wave_right_arm",
      ok: true,
    },
  }, cookie);
  await say(id, "robot", "The right arm waved gently twice.");

  const history = await readMessages(id);
  expect(history.map((m: any) => m.kind)).toEqual(["text", "tool", "text"]);
  const tool = history[1] as any;
  // The authored code is the point of keeping this at all.
  expect(tool.payload.input.code).toContain("def run(ctx)");
  expect(tool.payload.ok).toBe(true);
});

test("a tool row does not steal the conversation title", async () => {
  const id = await newConversation();
  await json("/api/messages", {
    id: crypto.randomUUID(),
    conversationId: id,
    author: "robot",
    kind: "tool",
    text: "Checking what it already knows",
    payload: { name: "list_skills", input: {}, ok: true },
  }, cookie);
  expect((await listConversations()).find((t) => t.id === id)).toBeUndefined();

  await say(id, "you", "now teach it something");
  expect((await listConversations()).find((t) => t.id === id)!.title).toBe(
    "now teach it something",
  );
});

test("a tool row without a payload is refused", async () => {
  const id = await newConversation();
  const res = await json("/api/messages", {
    id: crypto.randomUUID(),
    conversationId: id,
    author: "robot",
    kind: "tool",
    text: "nope",
  }, cookie);
  expect(res.status).toBe(400);
});

test("a runaway payload is refused rather than stored", async () => {
  const id = await newConversation();
  const res = await json("/api/messages", {
    id: crypto.randomUUID(),
    conversationId: id,
    author: "robot",
    kind: "tool",
    text: "huge",
    payload: { name: "save_skill", input: { code: "x".repeat(30_000) } },
  }, cookie);
  expect(res.status).toBe(413);
});

test("ordinary messages are unaffected and default to text", async () => {
  const id = await newConversation();
  await say(id, "you", "just words");
  const [only] = await readMessages(id);
  expect((only as any).kind).toBe("text");
  expect((only as any).payload).toBeNull();
});
