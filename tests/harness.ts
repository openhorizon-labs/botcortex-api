/**
 * A real app on in-memory Postgres — the real generated migrations, the real
 * Better Auth, the real Hono routes. No Supabase, no network, no mocks of
 * our own code, so a passing test says something about production.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/pglite";

import { CLI_CLIENT_ID } from "../src/client.js";
import { createApp } from "../src/hono.js";
import * as schema from "../src/schema.js";

export const ORIGIN = "http://localhost:3000";

export async function makeApp() {
  const pglite = new PGlite();
  const migrations = join(import.meta.dir, "..", "drizzle");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(join(migrations, file), "utf8").split(
      "--> statement-breakpoint",
    )) {
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
    // The same plugins production runs — a pairing test against an auth
    // instance without them would prove nothing about the real flow.
    plugins: [
      bearer(),
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        verificationUri: `${ORIGIN}/device`,
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
      }),
    ],
  });
  return { app: createApp(auth, [ORIGIN], db), db };
}

/** Signs a user up and returns the cookie the web app would then carry. */
export async function signUp(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  email = "owner@example.com",
): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ name: "Test Owner", email, password: "correct-horse-battery" }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}
