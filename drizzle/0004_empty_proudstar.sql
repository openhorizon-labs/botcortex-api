CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"user_id" text NOT NULL,
	"robot_name" text,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_user_idx" ON "message" USING btree ("user_id","seq");