-- Runs kept as training data (src/episodes.ts). Additive, and safe to run twice.
CREATE TABLE IF NOT EXISTS "episode" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"source" text NOT NULL,
	"platform" text NOT NULL,
	"backend" text NOT NULL,
	"skill" text,
	"instruction" text,
	"phase" text,
	"executed" boolean DEFAULT false NOT NULL,
	"ok" boolean NOT NULL,
	"kind" text,
	"primitive" text,
	"note" text,
	"code_sha" text,
	"code" text,
	"failure_id" text,
	"repairs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repaired_by" text,
	"replays" text,
	"length" integer NOT NULL,
	"fps" integer NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ticks_gz" text NOT NULL,
	"recorded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "episode_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "episode_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episode_platform_skill_idx" ON "episode" USING btree ("platform","skill");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episode_outcome_idx" ON "episode" USING btree ("ok","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episode_created_idx" ON "episode" USING btree ("created_at");