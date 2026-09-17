/**
 * Task titles: the owner's words, shortened only when they need it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { tidyTitle } from "../src/titles.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let cookie: string;
let server: ReturnType<typeof Bun.serve>;
let calls = 0;
let reply = "Blue in tray, stack red and green";

beforeAll(async () => {
  ({ app } = await makeApp());
  cookie = await signUp(app, "titles@example.com");
  await app.request("/api/credits", { headers: { Cookie: cookie, Origin: ORIGIN } }); // the welcome credit
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls += 1;
      await req.json();
      return Response.json({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 120, completion_tokens: 12 } });
    },
  });
  process.env.OPENAI_UPSTREAM_URL = `http://localhost:${server.port}`;
  process.env.OPENAI_API_KEY = "sk-server-side-secret";
});
afterAll(() => {
  server?.stop(true);
  delete process.env.OPENAI_UPSTREAM_URL;
  delete process.env.OPENAI_API_KEY;
});

const post = (path: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN }, body: JSON.stringify(body ?? {}) });

async function task(text: string) {
  const { id } = (await (await post("/api/conversations", { platform: "vx300s" })).json()) as { id: string };
  await post("/api/messages", { id: crypto.randomUUID(), conversationId: id, author: "you", text });
  return id;
}

test("what the model says is made fit for a sidebar, or refused", () => {
  expect(tidyTitle('"Stack red on blue."')).toBe("Stack red on blue");
  expect(tidyTitle("Stack red on blue\n\nHere is why…")).toBe("Stack red on blue");
  expect(tidyTitle("")).toBeNull();
  expect(tidyTitle("This is a whole sentence describing what the owner asked for in great detail")).toBeNull();
  expect(tidyTitle(null)).toBeNull();
});

test("a short message is its own title and no model is asked", async () => {
  const id = await task("wave the left arm");
  const before = calls;
  expect(await (await post(`/api/conversations/${id}/title`)).json()).toEqual({ title: "wave the left arm", changed: false });
  expect(calls).toBe(before);
});

test("a long message is shortened once, charged to the owner at cost, and not redone", async () => {
  const long = "Lift the arm high, then bring it back down slowly, then keep the blue block inside the right side tray and stack red upon blue";
  const id = await task(long);
  const spentBefore = (await (await app.request("/api/credits", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()).spentMicros;
  expect(await (await post(`/api/conversations/${id}/title`)).json()).toEqual({ title: "Blue in tray, stack red and green", changed: true });
  const spent = (await (await app.request("/api/credits", { headers: { Cookie: cookie, Origin: ORIGIN } })).json()).spentMicros;
  expect(spent).toBeGreaterThan(spentBefore);
  expect(spent - spentBefore).toBeLessThan(100); // well under a hundredth of a cent

  const asked = calls;
  expect(await (await post(`/api/conversations/${id}/title`)).json()).toMatchObject({ changed: false, title: "Blue in tray, stack red and green" });
  expect(calls).toBe(asked);
});

test("an unusable answer leaves the owner's words in place, and someone else's task is not found", async () => {
  reply = "I would be happy to help you come up with a good title for this particular request today";
  const long = "Please pick up every single block on the table one at a time and put them all neatly away";
  const id = await task(long);
  expect(await (await post(`/api/conversations/${id}/title`)).json()).toEqual({ title: long.slice(0, 60).trim(), changed: false });

  const other = await signUp(app, "nosy-titles@example.com");
  const res = await app.request(`/api/conversations/${id}/title`, { method: "POST", headers: { Cookie: other, Origin: ORIGIN } });
  expect(res.status).toBe(404);
});
