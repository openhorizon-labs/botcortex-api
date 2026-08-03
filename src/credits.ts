/**
 * The credit ledger.
 *
 * Balance is derived — sum of grants minus sum of usage — never a stored
 * running total. Deriving costs one extra query per call and makes drift
 * structurally impossible; at preview volume that is the right trade.
 *
 * The cap is SOFT by construction: we check the balance before forwarding
 * and debit after the response, so a single large call can finish slightly
 * negative. That is deliberate — the alternative is reserving tokens we
 * cannot predict, and killing a teach mid-authoring to save a fraction of a
 * cent is a worse outcome than a small overshoot.
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "./db.js";
import { creditGrant, usage } from "./app-schema.js";

/** New accounts start with this much, so a tester can teach immediately. */
export const SIGNUP_GRANT_MICROS = 2_000_000; // $2.00

export interface Balance {
  grantedMicros: number;
  spentMicros: number;
  balanceMicros: number;
}

/** Postgres SUM() arrives as a string through both postgres-js and PGlite —
 *  coercing explicitly keeps this arithmetic instead of concatenation. */
function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

export async function balanceFor(db: Db, userId: string): Promise<Balance> {
  const [grants] = await db
    .select({ total: sql<string>`coalesce(sum(${creditGrant.amountMicros}), 0)` })
    .from(creditGrant)
    .where(eq(creditGrant.userId, userId));
  const [spend] = await db
    .select({ total: sql<string>`coalesce(sum(${usage.costMicros}), 0)` })
    .from(usage)
    .where(eq(usage.userId, userId));

  const grantedMicros = toNumber(grants?.total);
  const spentMicros = toNumber(spend?.total);
  return { grantedMicros, spentMicros, balanceMicros: grantedMicros - spentMicros };
}

export async function grant(
  db: Db,
  userId: string,
  amountMicros: number,
  reason: string,
): Promise<void> {
  await db
    .insert(creditGrant)
    .values({ id: crypto.randomUUID(), userId, amountMicros, reason });
}

export async function recordUsage(
  db: Db,
  row: {
    userId: string;
    keyId: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  },
): Promise<void> {
  await db.insert(usage).values({ id: crypto.randomUUID(), ...row });
}

/**
 * Micro-dollars as a human string.
 *
 * Sub-cent precision is not pedantry here: a whole teach on the cheapest model
 * costs about a fifth of a cent, so at two decimals a balance sits at "$3.00"
 * through hundreds of them. A number that never moves reads as a billing
 * system that is not working — which is exactly how this was reported.
 *
 * Round amounts keep the familiar two decimals; anything with sub-cent detail
 * shows four, so spending is visible as it happens.
 */
export function formatMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  const roundCents = Number.isInteger(Math.round(dollars * 1_000_000) / 10_000);
  return `$${dollars.toFixed(roundCents ? 2 : 4)}`;
}
