ALTER TABLE "conversation" ADD COLUMN "platform" text;--> statement-breakpoint
CREATE INDEX "conversation_user_platform_idx" ON "conversation" USING btree ("user_id","platform");
