/**
 * The Hono app — split from the Bun entrypoint so tests can drive it
 * in-process with a different auth/db wiring.
 *
 * Two authentication worlds meet here and never mix:
 *   /api/*  session cookie, called by the web app through its Next rewrite
 *   /v1/*   robot key, called by a runtime on someone's robot
 */
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Db } from "./db.js";
import { accountRoutes } from "./routes/account.js";
import { robotRoutes } from "./routes/robot.js";

/** The slice of a Better Auth instance the app actually uses — structural,
 *  so any betterAuth() instantiation fits regardless of its generic params. */
export interface AuthLike {
  handler: (request: Request) => Response | Promise<Response>;
  api: {
    getSession: (input: {
      headers: Headers;
    }) => Promise<{ user: unknown; session: unknown } | null>;
  };
}

export function createApp(auth: AuthLike, origins: string[], db: Db) {
  const app = new Hono();

  // CORS must be registered before the routes it protects.
  app.use(
    "/api/*",
    cors({
      origin: origins,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
      exposeHeaders: ["Content-Length"],
      maxAge: 600,
      credentials: true,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, service: "botcortex-api" }));

  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/api/me", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ user: null }, 401);
    return c.json({ user: session.user });
  });

  // Registered after the handlers above so their terminating responses win;
  // this sub-app's session guard only ever runs for its own paths.
  app.route("/api", accountRoutes(auth, db));

  // No CORS: robots are not browsers, and nothing here should be reachable
  // from a page's fetch carrying ambient credentials.
  app.route("/v1", robotRoutes(db));

  return app;
}
