/**
 * The entrypoint everywhere: Vercel's Hono backend detection requires this
 * file to import `hono` directly and export the app as default; Bun serves
 * the same export locally (PORT env honored). One artifact, no adapters.
 */
import type { Hono } from "hono";

import { auth, trustedOrigins } from "./auth.js";
import { db } from "./db.js";
import { createApp } from "./hono.js";

const app: Hono = createApp(auth, trustedOrigins, db);

export default app;
