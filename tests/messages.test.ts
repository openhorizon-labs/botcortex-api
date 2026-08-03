/**
 * Chat history. The transcript used to live in React state and a refresh wiped
 * it — the robot remembered the skill, the owner lost the conversation.
 */
import { beforeAll, expect, test } from "bun:test";

import { ORIGIN, makeApp, signUp } from "./harness.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let cookie: string;

const post = (body: unknown, as = cookie) =>
  app.request("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: as },
    body: JSON.stringify(body),
  });

const list = async (as = cookie) => {
  const res = await app.request("/api/messages", {
    headers: { Cookie: as, Origin: ORIGIN },
  });
  return (await res.json()).messages as { id: string; author: string; text: string }[];
};

beforeAll(async () => {
  ({ app } = await makeApp());
  cookie = await signUp(app, "chat@example.com");
});

test("messages round-trip oldest-first", async () => {
  expect((await post({ id: "m1", author: "you", text: "wave the right arm" })).status).toBe(200);
  expect((await post({ id: "m2", author: "robot", text: "Done — it waved." })).status).toBe(200);

  const history = await list();
  expect(history.map((m) => m.text)).toEqual(["wave the right arm", "Done — it waved."]);
  expect(history[0].author).toBe("you");
});

test("re-posting the same id does not duplicate the transcript", async () => {
  // The exact failure a retry or a double-mounted effect would cause.
  await post({ id: "m1", author: "you", text: "wave the right arm" });
  await post({ id: "m1", author: "you", text: "wave the right arm" });
  const history = await list();
  expect(history.filter((m) => m.id === "m1")).toHaveLength(1);
});

test("history is per-owner", async () => {
  const other = await signUp(app, "someone-else@example.com");
  await post({ id: "theirs", author: "you", text: "not yours" }, other);

  expect((await list()).some((m) => m.id === "theirs")).toBe(false);
  expect((await list(other)).map((m) => m.text)).toEqual(["not yours"]);
});

test("a bad author is rejected rather than stored", async () => {
  const res = await post({ id: "bad", author: "hacker", text: "x" });
  expect(res.status).toBe(400);
  expect((await list()).some((m) => m.id === "bad")).toBe(false);
});

test("the limit keeps the RECENT tail, not the oldest", async () => {
  const fresh = await signUp(app, "chatty@example.com");
  for (let i = 0; i < 12; i += 1) {
    await post({ id: `seq-${i}`, author: "you", text: `message ${i}` }, fresh);
  }
  const res = await app.request("/api/messages?limit=3", {
    headers: { Cookie: fresh, Origin: ORIGIN },
  });
  const tail = (await res.json()).messages as { text: string }[];
  expect(tail).toHaveLength(3);
  // Ascending-then-LIMIT would have returned messages 0,1,2.
  expect(tail.map((m) => m.text)).toEqual(["message 9", "message 10", "message 11"]);
});

test("clearing wipes only the caller's conversation", async () => {
  const other = await signUp(app, "keeper@example.com");
  await post({ id: "keep-me", author: "you", text: "still here" }, other);

  const cleared = await app.request("/api/messages", {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  expect(cleared.status).toBe(200);
  expect(await list()).toHaveLength(0);
  expect((await list(other)).map((m) => m.text)).toEqual(["still here"]);
});

test("history needs a session", async () => {
  expect((await app.request("/api/messages")).status).toBe(401);
});
