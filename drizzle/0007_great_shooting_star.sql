DROP INDEX "skill_user_name_idx";--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "proven" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_user_platform_name_idx" ON "skill" USING btree ("user_id","platform","name");