// The starter set: about 5-6 minutes of each language's corpus for a new user to record first, picked to
// cover as much as possible in little time. Greedy selection by gain per second of reading:
// - sounds: phoneme proxies (letters and vowel signs, Hangul jamo, pinyin/Jyutping initials and finals,
//   Japanese morae) and the sound pairs they form, weighted by how common each pair is in the corpus;
// - the corpus's most frequent words, weighted by frequency;
// - quotas of lines with numbers, dates, times, money, names, places and mixed-in English words
//   (tagged once per language by the LLM);
// - 2-3 short passages for natural rhythm, then mostly short sentences.
import type { Item } from "./checks";
import { itemSeconds } from "./checks";
import type { Profile } from "./langs";
import { askJson, REVIEW_MODEL } from "./llm";

export const TAGS = ["number", "date", "time", "money", "name", "place", "english"] as const;
export type Tag = (typeof TAGS)[number];
const QUOTA: Record<Tag, number> = { number: 6, date: 3, time: 3, money: 3, name: 6, place: 4, english: 8 };
const BUDGET = { min: 300, target: 330, max: 360 }; // seconds of reading, pauses included

export async function tagItems(p: Profile, items: Item[]): Promise<Map<string, Tag[]>> {
  const rows = items.map((x) => `${x.id}: ${x.native.join(" ")}`).join("\n");
  const ans = await askJson([
    { role: "system", content: `You annotate ${p.name} text precisely. Answer in JSON.` },
    { role: "user", content: `For each item, list which of these it contains:
- number: any number (digits or number words)
- date: a calendar date or a day of the week
- time: a clock time or time of day with a number
- money: an amount of money
- name: a person's name
- place: a named place (city, neighborhood, street, landmark, shop name)
- english: English words mixed into the ${p.name} text${p.code === "en" ? " (never for English itself)" : ""}

${rows}

Answer with JSON: {"tags": {"<id>": ["number", ...], ...}} with every id present (an empty list when none apply).` },
  ], (x) => {
    if (!x.tags || typeof x.tags !== "object") throw new Error(`expected "tags"`);
    const m = new Map<string, Tag[]>();
    for (const it of items) {
      const t = x.tags[it.id];
      if (!Array.isArray(t)) throw new Error(`no tags for ${it.id}`);
      m.set(it.id, t.filter((v: string) => (TAGS as readonly string[]).includes(v)) as Tag[]);
    }
    return m;
  }, { tag: `${p.code}-tags`, model: REVIEW_MODEL, effort: "medium" });
  if (p.code === "en") for (const [k, v] of ans) ans.set(k, v.filter((t) => t !== "english"));
  return ans;
}

const PINYIN = /(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?([aeiouv]+(?:ng|n|r)?)/g;
const JYUTPING = /(gw|kw|ng|[bpmfdtnlgkhzcsjw])?([aeiouy]+(?:ng|[mnptk])?|m|ng)/g;
const MORA = /(?:ky|gy|sh|ch|ny|hy|by|py|my|ry|ts|[kgsztdnhbpmyrwfjv])?[aiueo]|n(?![aiueoy])|([kgstdhbpmrfjzc])(?=\1)/g;

/** Sound units (phoneme proxies) and the sound pairs they form, for each line of an item. */
export function sounds(p: Profile, item: Item): { units: string[]; pairs: string[] } {
  const units: string[] = [], pairs: string[] = [];
  const src = (i: number) => (["zh", "yue", "ja"].includes(p.code) ? item.roman![i]! : item.native[i]!);
  for (let i = 0; i < item.native.length; i++) {
    const text = src(i).normalize(p.script === "Hangul" ? "NFD" : "NFC").toLowerCase();
    for (const w of text.split(/[^\p{L}\p{M}]+/u).filter(Boolean)) {
      let seq: string[];
      if (p.code === "zh" || p.code === "yue") {
        seq = [];
        for (const m of w.matchAll(p.code === "zh" ? PINYIN : JYUTPING)) {
          if (m[1]) seq.push(m[1]);
          seq.push(m[2]!);
          pairs.push(`${m[1] ?? ""}${m[2]}`); // a whole syllable is the pair of its initial and final
        }
        units.push(...seq);
        continue;
      } else if (p.code === "ja") seq = [...w.matchAll(MORA)].map((m) => m[0]);
      else seq = [...w];
      units.push(...seq);
      for (let k = 1; k < seq.length; k++) pairs.push(seq[k - 1]! + seq[k]!);
    }
  }
  return { units, pairs };
}

/** Words for frequency coverage: romanized words for scripts without spaces or with roman word grouping. */
export function words(p: Profile, item: Item): string[] {
  const useRoman = ["Han", "Japanese", "Thai", "Lao", "Khmer", "Myanmar"].includes(p.script) && item.roman;
  return (useRoman ? item.roman! : item.native).join(" ").normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}']+/u).filter(Boolean);
}

export type StarterResult = { ids: string[]; stats: Record<string, unknown> };

export function selectStarter(p: Profile, items: Item[], tags: Map<string, Tag[]>): StarterResult {
  const sec = new Map(items.map((x) => [x.id, itemSeconds(p, x)]));
  const S = new Map(items.map((x) => [x.id, sounds(p, x)]));
  const W = new Map(items.map((x) => [x.id, words(p, x)]));
  const count = (lists: Iterable<string[]>) => {
    const m = new Map<string, number>();
    for (const l of lists) for (const t of l) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const unitFreq = count([...S.values()].map((s) => s.units));
  const pairFreq = count([...S.values()].map((s) => s.pairs));
  const wordFreq = count(W.values());
  const totalTokens = [...wordFreq.values()].reduce((a, b) => a + b, 0);
  const topWords = [...wordFreq].sort((a, b) => b[1] - a[1]).slice(0, 300);
  const topSet = new Map(topWords);

  const have = { units: new Set<string>(), pairs: new Set<string>(), words: new Set<string>() };
  const tagCount = Object.fromEntries(TAGS.map((t) => [t, 0])) as Record<Tag, number>;
  const quota = { ...QUOTA, ...(p.code === "en" ? { english: 0 } : {}) };

  const gain = (it: Item) => {
    const s = S.get(it.id)!;
    let g = 0;
    for (const u of new Set(s.units)) if (!have.units.has(u)) g += 3;
    for (const pr of new Set(s.pairs)) if (!have.pairs.has(pr)) g += Math.log2(1 + pairFreq.get(pr)!) * 0.5;
    for (const w of new Set(W.get(it.id)!)) if (!have.words.has(w) && topSet.has(w)) g += (topSet.get(w)! / totalTokens) * 400;
    for (const t of tags.get(it.id) ?? []) if (tagCount[t] < quota[t]) g += 4;
    return g;
  };
  const take = (it: Item) => {
    const s = S.get(it.id)!;
    s.units.forEach((u) => have.units.add(u));
    s.pairs.forEach((x) => have.pairs.add(x));
    W.get(it.id)!.forEach((w) => have.words.add(w));
    for (const t of tags.get(it.id) ?? []) tagCount[t]++;
  };

  const chosen: Item[] = [];
  let total = 0;
  const best = (pool: Item[]) => pool.reduce<{ it: Item; v: number } | null>((b, it) => {
    const v = gain(it) / sec.get(it.id)!;
    return !b || v > b.v ? { it, v } : b;
  }, null);

  // Two or three short passages first (the shorter half of the passages).
  const paras = items.filter((x) => x.kind === "para").sort((a, b) => sec.get(a.id)! - sec.get(b.id)!);
  let short = paras.slice(0, Math.max(3, Math.ceil(paras.length / 2)));
  for (let k = 0; k < 3 && short.length; k++) {
    const b = best(short)!;
    if (k === 2 && total + sec.get(b.it.id)! > BUDGET.target * 0.45) break;
    chosen.push(b.it);
    take(b.it);
    total += sec.get(b.it.id)!;
    short = short.filter((x) => x !== b.it);
  }
  // Then sentences, preferring short ones (a 7 s cap keeps the set mostly short lines).
  let pool = items.filter((x) => x.kind === "sentence" && sec.get(x.id)! <= 7);
  while (total < BUDGET.target && pool.length) {
    const fits = pool.filter((x) => total + sec.get(x.id)! <= BUDGET.max);
    if (!fits.length) break;
    const b = best(fits)!;
    chosen.push(b.it);
    take(b.it);
    total += sec.get(b.it.id)!;
    pool = pool.filter((x) => x !== b.it);
  }

  // Reading order: sentences in pick order, passages spread through the session.
  const ps = chosen.filter((x) => x.kind === "para"), ss = chosen.filter((x) => x.kind === "sentence");
  const ordered: Item[] = [...ss];
  ps.forEach((x, k) => ordered.splice(Math.round(((k + 1) * (ss.length + k)) / (ps.length + 1)), 0, x));

  const pct = (a: number, b: number) => +((100 * a) / Math.max(1, b)).toFixed(1);
  const tokCovered = [...wordFreq].filter(([w]) => have.words.has(w)).reduce((a, [, n]) => a + n, 0);
  const pairTokCovered = [...pairFreq].filter(([x]) => have.pairs.has(x)).reduce((a, [, n]) => a + n, 0);
  const pairTok = [...pairFreq.values()].reduce((a, b) => a + b, 0);
  return {
    ids: ordered.map((x) => x.id),
    stats: {
      minutes: +(total / 60).toFixed(1),
      passages: chosen.filter((x) => x.kind === "para").length,
      sentences: ss.length,
      soundUnits: `${have.units.size}/${unitFreq.size} (${pct(have.units.size, unitFreq.size)}%)`,
      soundPairTypes: `${have.pairs.size}/${pairFreq.size} (${pct(have.pairs.size, pairFreq.size)}%)`,
      soundPairTokens: `${pct(pairTokCovered, pairTok)}%`,
      top100Words: `${pct(topWords.slice(0, 100).filter(([w]) => have.words.has(w)).length, Math.min(100, topWords.length))}%`,
      wordTokens: `${pct(tokCovered, totalTokens)}%`,
      tags: tagCount,
    },
  };
}
