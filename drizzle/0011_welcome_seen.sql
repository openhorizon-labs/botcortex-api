-- When the owner was told about a grant. Null = not yet announced.
-- (drizzle-kit also wanted to re-add conversation.platform here: 0010 was
-- written by hand and never reached the snapshot. It is already applied, so it
-- is left out; the snapshot beside this file is correct from here on.)
ALTER TABLE "credit_grant" ADD COLUMN IF NOT EXISTS "seen_at" timestamp;--> statement-breakpoint
-- Every grant that predates the welcome dialog counts as already announced:
-- nobody who has been teaching for weeks should be told they "just got" $2.
UPDATE "credit_grant" SET "seen_at" = "created_at" WHERE "seen_at" IS NULL;
