-- Public handles, and who-ran-what for ranking the registry. Both additive.
CREATE TABLE IF NOT EXISTS "profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "profile_handle_unique" UNIQUE("handle"),
	CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_run" (
	"skill_id" text NOT NULL,
	"visitor" text NOT NULL,
	"day" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_run_skill_id_visitor_day_pk" PRIMARY KEY("skill_id","visitor","day"),
	CONSTRAINT "skill_run_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade
);
