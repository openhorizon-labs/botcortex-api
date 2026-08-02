/**
 * Vercel entrypoint — Node.js runtime functions (NOT Edge: Better Auth +
 * Drizzle reach Supabase over a TCP Postgres driver, which Edge cannot open).
 * vercel.json routes every path here; Bun keeps serving local dev.
 */
import { handle } from "hono/vercel";

import { auth, trustedOrigins } from "../src/auth";
import { createApp } from "../src/app";

const app = createApp(auth, trustedOrigins);

export default handle(app);
