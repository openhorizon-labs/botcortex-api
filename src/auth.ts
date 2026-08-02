/**
 * Better Auth configuration — the identity layer for BotCortex.
 * Email + password for the test build; social/magic-link wait on an email
 * provider decision. The web app talks to these routes cross-origin, so
 * trustedOrigins must list every app origin.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "./db.js";
import * as schema from "./auth-schema.js";

export const trustedOrigins = (
  process.env.TRUSTED_ORIGINS ?? "http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  trustedOrigins,
});
