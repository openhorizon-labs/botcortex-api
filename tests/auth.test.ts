/**
 * Full-stack auth round-trip on PGlite (in-memory Postgres) — no Supabase,
 * no network. Applies the real generated migration, mounts the real Hono app,
 * signs a user up, and reads the session back.
 */
import { beforeAll, expect, test } from "bun:test";

import { ORIGIN, makeApp } from "./harness.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];

beforeAll(async () => {
  ({ app } = await makeApp());
});

test("health responds", async () => {
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
});

test("sign-up, then session readable via /api/me", async () => {
  const signUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      name: "Test Owner",
      email: "owner@example.com",
      password: "correct-horse-battery",
    }),
  });
  expect(signUp.status).toBe(200);
  const setCookie = signUp.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();

  const me = await app.request("/api/me", {
    headers: { Cookie: setCookie!.split(";")[0], Origin: ORIGIN },
  });
  expect(me.status).toBe(200);
  expect((await me.json()).user.email).toBe("owner@example.com");
});

test("unauthenticated /api/me is a 401", async () => {
  const res = await app.request("/api/me");
  expect(res.status).toBe(401);
});
