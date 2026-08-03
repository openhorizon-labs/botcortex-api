CREATE TABLE "conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_user_idx" ON "conversation" USING btree ("user_id","updated_at");--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "conversation_id" text;--> statement-breakpoint
INSERT INTO "conversation" ("id", "user_id", "title", "created_at", "updated_at")
SELECT
	gen_random_uuid()::text,
	m."user_id",
	COALESCE(
		(SELECT left(m2."text", 40) FROM "message" m2
			WHERE m2."user_id" = m."user_id" AND m2."author" = 'you'
			ORDER BY m2."seq" ASC LIMIT 1),
		'Earlier conversation'
	),
	MIN(m."created_at"),
	MAX(m."created_at")
FROM "message" m
WHERE m."conversation_id" IS NULL
GROUP BY m."user_id";--> statement-breakpoint
UPDATE "message" m
SET "conversation_id" = c."id"
FROM "conversation" c
WHERE c."user_id" = m."user_id" AND m."conversation_id" IS NULL;--> statement-breakpoint
DROP INDEX "message_user_idx";--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_convo_idx" ON "message" USING btree ("conversation_id","seq");
