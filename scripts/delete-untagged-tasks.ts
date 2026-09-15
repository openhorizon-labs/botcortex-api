/**
 * Delete an account's tasks that carry no robot.
 *
 * Tasks from before the body was recorded belong to no robot and, since the
 * sidebar lists only the connected robot's tasks, would never be shown
 * again. Sai asked for them to be cleared (Sep 16, 2026). Messages go with
 * them (cascade).
 *
 *   DATABASE_URL=… bun scripts/delete-untagged-tasks.ts owner@lab.dev
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/db.js";
import { user } from "../src/auth-schema.js";
import { conversation } from "../src/app-schema.js";

const [email] = process.argv.slice(2);
if (!email) {
  console.error("usage: bun scripts/delete-untagged-tasks.ts <email>");
  process.exit(1);
}
const [account] = await db.select().from(user).where(eq(user.email, email));
if (!account) {
  console.error(`no account for ${email}`);
  process.exit(1);
}
const gone = await db
  .delete(conversation)
  .where(and(eq(conversation.userId, account.id), isNull(conversation.platform)))
  .returning();
console.log(`deleted ${gone.length} untagged task(s) for ${email}`);
process.exit(0);
