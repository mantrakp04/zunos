// bun:sqlite adapter for scripts (migration, tests). The app uses expo-sqlite instead.
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrate, PRAGMAS } from "./index";
import * as schema from "./schema";

export async function openBunDb(file: string) {
  const sqlite = new Database(file, { create: true });
  sqlite.exec(PRAGMAS);
  await migrate({
    exec: (sql) => sqlite.exec(sql),
    appliedTags: () => sqlite.query<{ tag: string }, []>("SELECT tag FROM __migrations").all().map((r) => r.tag),
  });
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
