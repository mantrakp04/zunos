// The prompts the user reads (the built-in corpus and their own text) and the script each language is read in.
import { hasRoman, linesIn, readScript, schema, seedCorpus } from "@zunos/db";
import type { Lang, Script } from "@zunos/db/schema";
import { and, asc, eq, ne, sql } from "drizzle-orm";

import type { Language, PromptItem } from "../shared/types";
import type { Db } from "./db";

const { languages, prompts } = schema;

/** Prompts the Record screen lists: retired built-ins stay only for the takes that point at them. */
export const listed = ne(prompts.source, "retired");

export const withRoman = <T extends { code: Lang }>(l: T) => ({ ...l, hasRoman: hasRoman(l.code) });

/** Loads the corpus of these languages (or every enabled one) when it is new or changed. */
export async function seedLanguages(db: Db, langs?: Lang[]) {
  const codes = langs ?? (await db.select({ code: languages.code }).from(languages).where(eq(languages.enabled, true))).map((l) => l.code);
  return seedCorpus(db, codes);
}

export async function languageScript(db: Db, lang: Lang): Promise<Script> {
  const [l] = await db.select({ script: languages.script }).from(languages).where(eq(languages.code, lang));
  return l?.script ?? "native";
}

/** Read (and train) a language in its own script or in English letters. */
export async function setLanguageScript(db: Db, lang: Lang, script: Script): Promise<Language> {
  if (script !== "native" && script !== "roman") throw new Error(`Unknown script ${script}`);
  if (script === "roman" && !hasRoman(lang)) throw new Error("This language is already written in English letters.");
  await db.update(languages).set({ script }).where(eq(languages.code, lang));
  const [l] = await db.select().from(languages).where(eq(languages.code, lang));
  if (!l) throw new Error(`Unknown language ${lang}`);
  return withRoman(l);
}

/** Starter set first (in reading order), then passages, then sentences. */
export async function promptItems(db: Db, lang: Lang): Promise<PromptItem[]> {
  const script = await languageScript(db, lang);
  const rows = await db
    .select({
      id: prompts.id, lang: prompts.lang, kind: prompts.kind, title: prompts.title, native: prompts.native, roman: prompts.roman,
      starter: prompts.starter,
      recorded: sql<number>`exists(select 1 from recordings r where r.prompt_id = "prompts"."id")`,
    })
    .from(prompts)
    .where(and(eq(prompts.lang, lang), listed))
    .orderBy(
      sql`${prompts.starter} is null`, asc(prompts.starter),
      sql`case ${prompts.kind} when 'para' then 0 when 'twister' then 1 else 2 end`, asc(prompts.id),
    );
  return rows.map((r) => item(r, script, !!r.recorded));
}

function item(
  r: { id: string; lang: Lang; kind: PromptItem["kind"]; title: string | null; native: string[] | null; roman: string[] | null; starter: number | null },
  choice: Script, recorded: boolean,
): PromptItem {
  const script = readScript(r, choice);
  return { id: r.id, lang: r.lang, kind: r.kind, title: r.title, lines: linesIn(r, script), script, native: r.native, roman: r.roman, starter: r.starter !== null, recorded };
}

/** The user's own text, stored as the script they read the language in. */
export async function createUserPrompt(db: Db, lang: Lang, lines: string[]): Promise<PromptItem> {
  const script = hasRoman(lang) ? await languageScript(db, lang) : "native";
  const row = {
    id: `user-${lang}-${Date.now().toString(36)}`, lang, kind: lines.length > 1 ? ("para" as const) : ("sentence" as const),
    title: lines[0]!.slice(0, 60), native: script === "native" ? lines : null, roman: script === "roman" ? lines : null, starter: null,
  };
  await db.insert(prompts).values({ ...row, source: "user" });
  return item(row, script, false);
}

/** The script a take of this prompt is read in, as the Record screen shows it now. */
export async function takeScript(db: Db, promptId: string): Promise<Script> {
  const [p] = await db.select({ lang: prompts.lang, native: prompts.native, roman: prompts.roman }).from(prompts).where(eq(prompts.id, promptId));
  if (!p) throw new Error(`Unknown prompt ${promptId}`);
  return readScript(p, await languageScript(db, p.lang));
}

/**
 * What a take was read from: the lines in its script (the clips' text) and, when that is English letters,
 * the same lines in native script (the clips' native_text, the voice-cloning transcript on the pod).
 */
export function takeLines(p: { native: string[] | null; roman: string[] | null }, script: Script | null) {
  const s = script ?? readScript(p, "native");
  const lines = linesIn(p, s);
  const native = s === "roman" && p.native?.length === lines.length ? p.native : null;
  return { lines, native };
}

/** A clip's lines [first, last] in native script, when the take was read in English letters. */
export const nativeTextOf = (native: string[] | null | undefined, span: [number, number] | undefined) =>
  native && span ? native.slice(span[0], span[1] + 1).map((l) => l.trim()).join(" ") : null;
