// The reading corpus (corpus/<code>.json, written by scripts/corpus/generate.ts) and how prompts pick a script.
// Shared by the app (expo-sqlite) and bun scripts (bun:sqlite).
import { and, eq, notInArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import { CORPUS } from "./corpus.gen";
import { LANGUAGES } from "./languages";
import * as schema from "./schema";
import type { Lang, Script } from "./schema";

export type CorpusItem = { id: string; kind: "para" | "sentence"; title?: string; native: string[]; roman: string[] | null };
/** `starter`: the ids read first, in reading order. */
export type CorpusFile = { lang: Lang; starter: string[]; items: CorpusItem[] };

const { prompts, settings } = schema;

/** The script a language starts in: English letters for languages people type that way, else its own. */
export const defaultScript = (lang: Lang): Script => (LANGUAGES.find((l) => l.code === lang)?.romanized ? "roman" : "native");

/** Whether the language has an English-letter spelling besides its own script, so the reader can choose. */
export const hasRoman = (lang: Lang) => CORPUS[lang]?.roman ?? defaultScript(lang) === "roman";

/** The script a prompt is read in: the language's choice when the prompt has those lines, else the one it has. */
export function readScript(p: { native: string[] | null; roman: string[] | null }, choice: Script): Script {
  if (choice === "roman") return p.roman ? "roman" : "native";
  return p.native ? "native" : "roman";
}

/** A prompt's lines in a script (falling back to the script it has). */
export const linesIn = (p: { native: string[] | null; roman: string[] | null }, script: Script): string[] =>
  (script === "roman" ? p.roman ?? p.native : p.native ?? p.roman) ?? [];

// bun:sqlite and expo-sqlite drizzle databases share this query surface.
type AnyDb = BaseSQLiteDatabase<any, any, typeof schema>;

const SEEDED = "corpus"; // settings: { [lang]: version of the corpus file last seeded }
const recorded = sql`exists(select 1 from recordings r where r.prompt_id = "prompts"."id")`;
const referenced = sql`(${recorded} or exists(select 1 from synth_clips s where s.prompt_id = "prompts"."id"))`;

/**
 * Loads the corpus of each language into prompts, when its file changed since the last time. Items already
 * recorded keep their text (their takes were read from it); items gone from the file are deleted, or retired
 * when takes point at them. Each statement is short: the app may be recording meanwhile.
 */
export async function seedCorpus(db: AnyDb, langs: Lang[]): Promise<Lang[]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SEEDED));
  const seeded = { ...((row?.value as Record<string, string> | null) ?? {}) };
  const done: Lang[] = [];
  for (const lang of langs) {
    const entry = CORPUS[lang];
    if (!entry || seeded[lang] === entry.version) continue;
    const file = entry.load();
    const order = new Map(file.starter.map((id, i) => [id, i]));
    const rows = file.items.map((it) => ({
      id: it.id, lang, kind: it.kind, title: it.title ?? null, native: it.native, roman: it.roman,
      starter: order.get(it.id) ?? null, source: "corpus" as const,
    }));
    const keep = (col: string) => sql`case when ${recorded} then ${sql.identifier(col)} else excluded.${sql.identifier(col)} end`;
    for (let i = 0; i < rows.length; i += 100) {
      await db.insert(prompts).values(rows.slice(i, i + 100)).onConflictDoUpdate({
        target: prompts.id,
        set: {
          kind: keep("kind"), title: keep("title"), native: keep("native"), roman: keep("roman"),
          starter: sql`excluded.starter`, source: sql`excluded.source`,
        },
      });
    }
    const gone = and(eq(prompts.lang, lang), eq(prompts.source, "corpus"), notInArray(prompts.id, rows.map((r) => r.id)));
    await db.delete(prompts).where(and(gone, sql`not ${referenced}`));
    await db.update(prompts).set({ source: "retired", starter: null }).where(gone);
    seeded[lang] = entry.version;
    await db.insert(settings).values({ key: SEEDED, value: seeded })
      .onConflictDoUpdate({ target: settings.key, set: { value: seeded } });
    done.push(lang);
  }
  return done;
}
