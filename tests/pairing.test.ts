/**
 * The device pairing flow, end to end on in-memory Postgres.
 *
 * This is the path a real robot walks: ask for a code, say what you are,
 * wait, get approved by a human in a browser, trade the session for a durable
 * key, register. Every step is the real Better Auth plugin — no stubs.
 */
import { beforeAll, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ORIGIN, makeApp, signUp } from "./harness.js";
import { CLI_CLIENT_ID } from "../src/client.js";
import { robot } from "../src/app-schema.js";

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let cookie: string;

const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN, ...extra },
  body: JSON.stringify(body),
});

async function startPairing() {
  const res = await app.request(
    "/api/auth/device/code",
    json({ client_id: CLI_CLIENT_ID, scope: "teach" }),
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{ device_code: string; user_code: string; interval: number }>;
}

/** What the human does in the browser: bind the code, then approve. */
async function approve(userCode: string, as = cookie) {
  const bind = await app.request(`/api/auth/device?user_code=${userCode}`, {
    headers: { Cookie: as, Origin: ORIGIN },
  });
  expect(bind.status).toBe(200);
  return app.request("/api/auth/device/approve", json({ userCode }, { Cookie: as }));
}

beforeAll(async () => {
  ({ app, db } = await makeApp());
  cookie = await signUp(app, "pairing@example.com");
});

test("the verification URI points at the web app, not the api", async () => {
  const res = await app.request(
    "/api/auth/device/code",
    json({ client_id: CLI_CLIENT_ID }),
  );
  const body = await res.json();
  expect(body.verification_uri).toBe(`${ORIGIN}/app/device`);
  expect(body.user_code).toMatch(/^[A-Z0-9-]+$/);
  // The short code is what a human types; it must not be the secret.
  expect(body.user_code).not.toBe(body.device_code);
});

test("an unknown client cannot open a pairing", async () => {
  const res = await app.request("/api/auth/device/code", json({ client_id: "not-ours" }));
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test("describe names the robot for the approval screen", async () => {
  const { device_code, user_code } = await startPairing();
  const described = await app.request(
    "/v1/device/describe",
    json({ device_code, name: "thor-rig", platform: "openarm_v1", arms: 2 }),
  );
  expect(described.status).toBe(200);

  const pending = await app.request(`/api/device/pending?user_code=${user_code}`, {
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  const body = await pending.json();
  expect(body.robot.name).toBe("thor-rig");
  expect(body.robot.platform).toBe("openarm_v1");
});

test("describe is rejected without the SECRET device code", async () => {
  const { user_code } = await startPairing();
  // The short code a shoulder-surfer can read must not be enough to plant a
  // misleading name on the approve screen.
  const res = await app.request(
    "/v1/device/describe",
    json({ device_code: user_code, name: "definitely-your-robot", platform: "openarm_v1" }),
  );
  expect(res.status).toBe(404);
});

test("polling before approval says authorization_pending, not an error", async () => {
  const { device_code } = await startPairing();
  const res = await app.request(
    "/api/auth/device/token",
    json({ grant_type: GRANT, device_code, client_id: CLI_CLIENT_ID }),
  );
  expect((await res.json()).error).toBe("authorization_pending");
});

test("a denied pairing never yields a token", async () => {
  const { device_code, user_code } = await startPairing();
  await app.request(`/api/auth/device?user_code=${user_code}`, {
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  await app.request("/api/auth/device/deny", json({ userCode: user_code }, { Cookie: cookie }));
  const res = await app.request(
    "/api/auth/device/token",
    json({ grant_type: GRANT, device_code, client_id: CLI_CLIENT_ID }),
  );
  expect((await res.json()).error).toBe("access_denied");
});

test("full pairing: approve, exchange for a key, register, and it shows up", async () => {
  const { device_code, user_code } = await startPairing();
  await app.request(
    "/v1/device/describe",
    json({ device_code, name: "bench-arm", platform: "so101", arms: 1 }),
  );

  const approved = await approve(user_code);
  expect(approved.status).toBe(200);

  const tokenRes = await app.request(
    "/api/auth/device/token",
    json({ grant_type: GRANT, device_code, client_id: CLI_CLIENT_ID }),
  );
  const { access_token, token_type } = await tokenRes.json();
  expect(token_type).toBe("Bearer");
  expect(access_token).toBeTruthy();

  // The exchange: a device session becomes a durable robot key. This is the
  // step that needs the bearer plugin — there is no cookie on a robot.
  const exchanged = await app.request(
    "/v1/keys/exchange",
    json({ name: "bench-arm" }, { Authorization: `Bearer ${access_token}` }),
  );
  expect(exchanged.status).toBe(201);
  const { key } = await exchanged.json();
  expect(key.startsWith("bx_live_")).toBe(true);

  // That key immediately works for inference auth.
  const me = await app.request("/v1/me", { headers: { Authorization: `Bearer ${key}` } });
  expect(me.status).toBe(200);
  expect((await me.json()).user.email).toBe("pairing@example.com");

  const registered = await app.request(
    "/v1/robots/register",
    json(
      { device_code, name: "bench-arm", platform: "so101", arms: 1, address: "192.168.1.42:9090" },
      { Authorization: `Bearer ${key}` },
    ),
  );
  expect(registered.status).toBe(200);

  const list = await app.request("/api/robots", {
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  const { robots } = await list.json();
  const bench = robots.find((r: { name: string }) => r.name === "bench-arm");
  expect(bench.address).toBe("192.168.1.42:9090");
  expect(bench.platform).toBe("so101");

  // The pairing row was claimed, not duplicated.
  const rows = await db.select().from(robot).where(eq(robot.name, "bench-arm"));
  expect(rows).toHaveLength(1);
  expect(rows[0].userCode).toBeNull();
});

test("re-registering the same robot updates rather than duplicating", async () => {
  const keys = await app.request(
    "/api/keys",
    json({ name: "rebooter" }, { Cookie: cookie }),
  );
  const { key } = await keys.json();

  for (const address of ["10.0.0.5:9090", "10.0.0.9:9090"]) {
    const res = await app.request(
      "/v1/robots/register",
      json(
        { name: "rebooter", platform: "openarm_v1", arms: 2, address },
        { Authorization: `Bearer ${key}` },
      ),
    );
    expect(res.status).toBe(200);
  }

  const rows = await db.select().from(robot).where(eq(robot.name, "rebooter"));
  expect(rows).toHaveLength(1);
  expect(rows[0].address).toBe("10.0.0.9:9090");
});

test("registration requires a robot key, not just any session", async () => {
  const res = await app.request(
    "/v1/robots/register",
    json({ name: "sneaky", platform: "openarm_v1" }, { Cookie: cookie }),
  );
  expect(res.status).toBe(401);
});
