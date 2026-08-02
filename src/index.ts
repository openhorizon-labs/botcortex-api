/**
 * The entrypoint everywhere: Vercel's Hono backend detection picks up
 * src/index.ts and requires the app as the default export; Bun serves the
 * same export locally (PORT env honored). One artifact, no adapters.
 */
import { auth, trustedOrigins } from "./auth";
import { createApp } from "./hono";

const app = createApp(auth, trustedOrigins);

export default app;
