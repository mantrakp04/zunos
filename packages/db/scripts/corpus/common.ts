// Helpers shared by the corpus generator (generate.ts) and the synthesis pool (synth.ts).
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Item, itemSeconds, romanVariants } from "./checks";
import type { Profile } from "./langs";
import { askJson, REVIEW_MODEL } from "./llm";
import { type Brief, briefPrompt, spellingPrompt } from "./prompts";

export const OUT_DIR = join(import.meta.dir, "../../corpus");

// ---------- small helpers ----------

export function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
export const shuffle = <T>(r: () => number, a: T[]) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
};
export const clean = (s: unknown) => {
  if (typeof s !== "string") throw new Error("expected a string");
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
};
export const lines = (x: unknown) => {
  if (!Array.isArray(x) || !x.length) throw new Error("expected a non-empty array of lines");
  return x.map(clean);
};
export const seconds = (p: Profile, items: Item[]) => items.reduce((s, x) => s + itemSeconds(p, x), 0);
export const log = (p: Profile, msg: string) => console.log(`[${p.code}] ${msg}`);

export function loadTestTexts(): string[] {
  const path = process.env.ZUNOS_DB ?? join(homedir(), "Library/Application Support/zunos/zunos.db");
  if (!existsSync(path)) throw new Error(`test clips database not found at ${path} (set ZUNOS_DB); refusing to run without the test-set check`);
  const db = new Database(path, { readonly: true });
  const rows = db.query("select text, native_text from clips where split = 'test'").all() as { text: string; native_text: string | null }[];
  db.close();
  return rows.flatMap((r) => [r.text, r.native_text ?? ""]).filter(Boolean);
}

// ---------- LLM steps ----------

export async function getBrief(p: Profile): Promise<Brief> {
  return askJson(briefPrompt(p), (x) => {
    const strs = (k: string, min: number) => {
      if (!Array.isArray(x[k]) || x[k].length < min) throw new Error(`"${k}" needs at least ${min} entries`);
      return x[k].map(clean) as string[];
    };
    const spellings = p.roman
      ? (Array.isArray(x.spellings) ? x.spellings : []).map((s: any) => ({ native: clean(s.native), roman: clean(s.roman) }))
      : [];
    if (p.roman && spellings.length < 60) throw new Error(`"spellings" needs at least 60 entries`);
    return {
      variety: clean(x.variety), orthography: clean(x.orthography), numbers: clean(x.numbers), codeMixing: clean(x.codeMixing),
      romanization: p.roman ? clean(x.romanization) : null, spellings,
      givenNames: strs("givenNames", 20), familyNames: strs("familyNames", 10), places: strs("places", 20),
      food: strs("food", 15), everyday: strs("everyday", 15), avoid: strs("avoid", 5),
    };
  }, { tag: `${p.code}-brief` });
}

export function ideas(r: () => number, b: Brief) {
  const fam = shuffle(r, b.familyNames);
  return {
    names: shuffle(r, b.givenNames).slice(0, 10).map((g, i) => (i % 3 === 0 && fam[i] ? `${g} ${fam[i]}` : g)),
    places: shuffle(r, b.places).slice(0, 8),
    food: shuffle(r, b.food).slice(0, 6),
    everyday: shuffle(r, b.everyday).slice(0, 6),
  };
}

export function parseItem(p: Profile, x: any, kind: "para" | "sentence") {
  // A sentence may come back as a string or as a one-line array (the review answers with arrays).
  const one = (v: unknown) => [Array.isArray(v) ? lines(v).join(" ") : clean(v)];
  const native = kind === "sentence" ? one(x?.native) : lines(x?.native);
  const roman = p.roman ? (kind === "sentence" ? one(x?.roman) : lines(x?.roman)) : null;
  if (roman && roman.length !== native.length) throw new Error(`roman has ${roman.length} lines but native has ${native.length}`);
  return { native, roman };
}


/**
 * Make romanized spellings consistent: words spelled several ways (same fuzzy key) go to the LLM, which
 * says whether they are one word and which spelling to keep; the roman lines are rewritten in place.
 */
export async function respell(p: Profile, b: Brief, items: { roman: string[] | null }[], tag: string, maxGroups: number) {
  const groups = romanVariants(items as Item[]).slice(0, maxGroups);
  if (!groups.length) return { groups: 0, changed: 0 };
  const ans = await askJson(spellingPrompt(p, b, groups), (x) => {
    if (!Array.isArray(x.groups)) throw new Error(`expected "groups"`);
    return x.groups as { n: number; same: boolean; use: string | null }[];
  }, { tag, model: REVIEW_MODEL });
  let changed = 0;
  for (const a of ans) {
    const g = groups[a.n - 1];
    if (!g || !a.same || !a.use) continue;
    const use = a.use.toLowerCase().trim();
    if (!/^[a-z']+$/.test(use)) continue;
    for (const variant of Object.keys(g.spellings)) {
      if (variant === use) continue;
      const re = new RegExp(`(?<![\\p{L}'])${variant}(?![\\p{L}'])`, "giu");
      for (const w of items)
        w.roman = w.roman?.map((l) => l.replace(re, (m) => {
          changed++;
          return m[0] === m[0]!.toUpperCase() ? use[0]!.toUpperCase() + use.slice(1) : use;
        })) ?? null;
    }
  }
  return { groups: groups.length, changed };
}
