CREATE TABLE "device_code" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "robot" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_code" text,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"arms" integer DEFAULT 2 NOT NULL,
	"address" text,
	"key_id" text,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "robot" ADD CONSTRAINT "robot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "robot" ADD CONSTRAINT "robot_key_id_robot_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."robot_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "robot_user_name_idx" ON "robot" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "robot_user_code_idx" ON "robot" USING btree ("user_code");