import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // The union of auth-schema (generated) and app-schema (ours) — pointing
  // this at auth-schema alone silently skips migrations for our tables.
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
