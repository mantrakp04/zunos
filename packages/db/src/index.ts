import { migrations } from "./migrations.gen";

export * from "./languages";
export * from "./schema";
export * as schema from "./schema";

export const DB_FILE = "zunos.db";

/** The two operations the migrator needs; implemented by expo-sqlite (async) and bun:sqlite (sync). */
export interface SqlRunner {
  exec(sql: string): unknown | Promise<unknown>;
  appliedTags(): string[] | Promise<string[]>;
}

/** Applies pending migrations in order, each in its own transaction. Returns the tags applied. */
export async function migrate(db: SqlRunner): Promise<string[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS __migrations (tag TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
  );
  const done = new Set(await db.appliedTags());
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.tag)) continue;
    const body = m.sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean).join(";\n");
    await db.exec(`BEGIN;\n${body};\nINSERT INTO __migrations (tag) VALUES ('${m.tag}');\nCOMMIT;`);
    applied.push(m.tag);
  }
  return applied;
}

export const PRAGMAS = "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;";
