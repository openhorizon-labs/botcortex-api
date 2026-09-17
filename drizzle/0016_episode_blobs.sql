-- Footage belonging to an episode, in parts (src/episodes.ts). Additive, safe to run twice.
CREATE TABLE IF NOT EXISTS "episode_blob" (
	"user_id" text NOT NULL,
	"episode_id" text NOT NULL,
	"name" text NOT NULL,
	"part" integer NOT NULL,
	"parts" integer NOT NULL,
	"size" integer NOT NULL,
	"storage" text NOT NULL,
	"bytes" "bytea",
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "episode_blob_user_id_episode_id_name_part_pk" PRIMARY KEY("user_id","episode_id","name","part"),
	CONSTRAINT "episode_blob_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade
);
