-- A profile people can recognise: a name of their choosing, a line about
-- them, a generated avatar, and whether they have been asked yet. Additive.
ALTER TABLE "profile" ADD COLUMN IF NOT EXISTS "first_name" text;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN IF NOT EXISTS "last_name" text;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN IF NOT EXISTS "bio" text;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN IF NOT EXISTS "avatar_seed" text;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN IF NOT EXISTS "onboarded_at" timestamp;
