/**
 * The skill registry's one write, shared by its two doors — a robot key
 * (POST /v1/skills) and the web session the browser sim teaches under
 * (POST /api/skills). Extracted the way inference.ts was and for the same
 * reason: a skill taught in the browser must land in the registry EXACTLY
 * the way a robot's does, or "teach in the browser today, pair a real arm
 * later, the skills are waiting" quietly becomes two subtly different
 * registries.
 */
import { skill } from "./app-schema.js";
import type { Db } from "./db.js";

/** Roughly a long authored skill plus its metadata. */
export const MAX_SKILL_CHARS = 24_000;

export type SkillUpsert =
  | { ok: true; name: string }
  | { ok: false; status: 400 | 413; error: string };

export async function upsertSkill(db: Db, userId: string, body: unknown): Promise<SkillUpsert> {
  const { name, description, code, platform } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || typeof code !== "string" || typeof description !== "string") {
    return { ok: false, status: 400, error: "name, description and code are required" };
  }
  if (name.length + description.length + code.length > MAX_SKILL_CHARS) {
    return { ok: false, status: 413, error: "skill too large" };
  }

  const now = new Date();
  await db
    .insert(skill)
    .values({
      id: crypto.randomUUID(),
      userId,
      name,
      description,
      code,
      platform: typeof platform === "string" ? platform : "unknown",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [skill.userId, skill.name],
      set: { description, code, updatedAt: now },
    });

  return { ok: true, name };
}
