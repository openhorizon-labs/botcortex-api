/**
 * Add BotCortex credits to an account.
 *
 * The manual top-up path until billing exists — and the one that keeps
 * working afterwards for comps, refunds, and testers.
 *
 *   DATABASE_URL=… bun scripts/grant-credits.ts owner@lab.dev 5.00 "beta tester"
 */
import { eq } from "drizzle-orm";

import { db } from "../src/db.js";
import { user } from "../src/auth-schema.js";
import { balanceFor, formatMicros, grant } from "../src/credits.js";

const [email, dollars, ...reasonParts] = process.argv.slice(2);
if (!email || !dollars) {
  console.error('usage: bun scripts/grant-credits.ts <email> <dollars> ["reason"]');
  process.exit(1);
}

const amount = Number(dollars);
if (!Number.isFinite(amount) || amount <= 0) {
  console.error(`"${dollars}" is not a positive dollar amount`);
  process.exit(1);
}

// Matched on the exact address, never a pattern — the same rule the delete
// path follows, so a typo can only fail to find someone.
const [account] = await db.select().from(user).where(eq(user.email, email));
if (!account) {
  console.error(`no account for ${email}`);
  process.exit(1);
}

const before = await balanceFor(db, account.id);
await grant(db, account.id, Math.round(amount * 1_000_000), reasonParts.join(" ") || "manual grant");
const after = await balanceFor(db, account.id);

console.log(
  `${account.email}: ${formatMicros(before.balanceMicros)} → ${formatMicros(after.balanceMicros)}`,
);
process.exit(0);
