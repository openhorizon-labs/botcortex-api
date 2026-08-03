/**
 * Better Auth configuration — the identity layer for BotCortex.
 * Email + password for the test build; social/magic-link wait on an email
 * provider decision. The web app talks to these routes cross-origin, so
 * trustedOrigins must list every app origin.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization } from "better-auth/plugins";


import { CLI_CLIENT_ID } from "./client.js";
import { db } from "./db.js";
import * as schema from "./auth-schema.js";

export const trustedOrigins = (
  process.env.TRUSTED_ORIGINS ?? "http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/** Where a human goes to approve a pairing — a page in the WEB app, not here. */
export const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");


export const plugins = [
  // A robot has no cookie jar. Without this the session token that
  // /device/token hands back can't authenticate anything, and pairing
  // dead-ends at the key exchange.
  bearer(),
  // RFC 8628. The robot never handles a password and the long-lived key is
  // never displayed — the human types a short code that is useless alone.
  deviceAuthorization({
    expiresIn: "10m",
    interval: "5s",
    // Under /app: every signed-in route lives there, and approving a pairing
    // requires a session. A robot prints this URL, so a stale path here sends
    // owners to a redirect at best and a dead link at worst.
    verificationUri: `${appUrl}/app/device`,
    validateClient: (clientId) => clientId === CLI_CLIENT_ID,
  }),
];

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  trustedOrigins,
  plugins,
});

export { CLI_CLIENT_ID };
