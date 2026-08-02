/**
 * Provision a waitlisted user (accounts are created by us and credentials
 * emailed — the app only exposes sign-in).
 *
 *   DATABASE_URL=… bun scripts/create-user.ts owner@lab.dev 'their-password' "Their Name"
 */
import { auth } from "../src/auth";

const [email, password, ...nameParts] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: bun scripts/create-user.ts <email> <password> ["Name"]');
  process.exit(1);
}

const result = await auth.api.signUpEmail({
  body: {
    email,
    password,
    name: nameParts.join(" ") || email.split("@")[0],
  },
});

console.log(`created: ${result.user.email} (${result.user.id})`);
process.exit(0);
