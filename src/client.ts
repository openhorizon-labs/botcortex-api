/**
 * Identifiers shared by the auth config and anything that needs them without
 * dragging in the database — importing auth.ts pulls in db.ts, which refuses
 * to load without DATABASE_URL, which would make tests need credentials.
 */

/** The only client allowed to open a device pairing. */
export const CLI_CLIENT_ID = "botcortex-cli";
