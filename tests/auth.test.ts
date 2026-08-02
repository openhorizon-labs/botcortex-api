/**
 * Full-stack auth round-trip on PGlite (in-memory Postgres) — no Supabase,
 * no network. Applies the real generated migration, mounts the real Hono app,
 * signs a user up, and reads the session back.
 */
import { beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/pglite";

import { createApp } from "../src/hono";
import * as schema from "../src/auth-schema";

const ORIGIN = "http://localhost:3000";
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const pglite = new PGlite();
  const migrations = join(import.meta.dir, "..", "drizzle");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrations, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      await pglite.exec(statement);
    }
  }
  const db = drizzle(pglite, { schema });
  const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    trustedOrigins: [ORIGIN],
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:8787",
  });
  app = createApp(auth, [ORIGIN]);
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
