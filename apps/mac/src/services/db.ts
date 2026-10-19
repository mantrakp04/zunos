import { DB_FILE, LANGUAGES, migrate, PRAGMAS, schema, SEED_PROMPTS, SEED_VERSION } from "@zunos/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/expo-sqlite";
import * as SQLite from "expo-sqlite";

import Native from "../../modules/zunos-native";

export const dataDir = Native.dataDir();

/** Absolute path for a path stored in the database (stored paths are relative to the data folder). */
export const abs = (p: string) => (p.startsWith("/") ? p : `${dataDir}/${p}`);

let opened: ReturnType<typeof open> | null = null;

function open() {
  // expo-sqlite parses the path with URL(string:); a plain path with spaces ("Application Support")
  // becomes a folder literally named "Application%20Support". A file URL is decoded correctly.
  const sqlite = SQLite.openDatabaseSync(DB_FILE, {}, `file://${encodeURI(dataDir)}`);
  sqlite.execSync(PRAGMAS);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

/** Opens ~/Library/Application Support/zunos/zunos.db and applies pending migrations. */
export async function openDb() {
  if (opened) return opened;
  const o = open();
  await migrate({
    exec: (sql) => o.sqlite.execAsync(sql),
    appliedTags: async () => (await o.sqlite.getAllAsync<{ tag: string }>("SELECT tag FROM __migrations")).map((r) => r.tag),
  });
  // Every language Whisper knows is selectable; existing rows (and their enabled flag) are kept.
  await o.db.insert(schema.languages).values(LANGUAGES.map((l, i) => ({
    code: l.code, name: l.name, script: l.romanized ? "Latin (romanized)" : "native", enabled: false, sort: i,
  }))).onConflictDoNothing();
  await seedPrompts(o.db);
  opened = o;
  return o;
}

async function seedPrompts(db: ReturnType<typeof open>["db"]) {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, "seed_version"));
  if (row?.value === SEED_VERSION) return;
  const rows = SEED_PROMPTS.map((p) => ({ ...p, source: "builtin" })) as (typeof schema.prompts.$inferInsert)[];
  for (let i = 0; i < rows.length; i += 100) await db.insert(schema.prompts).values(rows.slice(i, i + 100)).onConflictDoNothing();
  await db.insert(schema.settings).values({ key: "seed_version", value: SEED_VERSION })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: SEED_VERSION } });
}

export type Db = Awaited<ReturnType<typeof openDb>>["db"];
