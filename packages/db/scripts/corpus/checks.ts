// Automated checks on corpus items: scripts, line alignment, line and passage length, punctuation,
// duplicates and near-duplicates within a language, n-gram overlap with the held-back test clips, and
// spelling variants in the romanized lines.
import type { Profile, Script } from "./langs";

export type Item = {
  id: string;
  kind: "para" | "sentence";
  title?: string;
  native: string[];
  roman: string[] | null;
};

// Reading-time bounds, in seconds of speech.
// Earlier rounds: lines of 3-8 s worked best for voice cloning, and long or tongue-twisting lines were
// where it failed, so lines stay short to medium (about 4-20 words).
export const BOUNDS = {
  sentence: { min: 1.0, max: 9 },
  paraLine: { min: 2.0, max: 9 },
  para: { min: 25, max: 80, lines: [5, 10] as const },
  pauseBetweenLines: 0.6, // the reader pauses at every line break (the app cuts clips there)
};

const SCRIPT_RE: Record<Script, RegExp> = {
  Latin: /\p{scx=Latin}/u,
  Cyrillic: /\p{scx=Cyrillic}/u,
  Greek: /\p{scx=Greek}/u,
  Armenian: /\p{scx=Armenian}/u,
  Georgian: /\p{scx=Georgian}/u,
  Hebrew: /\p{scx=Hebrew}/u,
  Arabic: /\p{scx=Arabic}/u,
  Devanagari: /\p{scx=Devanagari}/u,
  Bengali: /\p{scx=Bengali}/u,
  Gurmukhi: /\p{scx=Gurmukhi}/u,
  Gujarati: /\p{scx=Gujarati}/u,
  Tamil: /\p{scx=Tamil}/u,
  Telugu: /\p{scx=Telugu}/u,
  Kannada: /\p{scx=Kannada}/u,
  Malayalam: /\p{scx=Malayalam}/u,
  Sinhala: /\p{scx=Sinhala}/u,
  Thai: /\p{scx=Thai}/u,
  Lao: /\p{scx=Lao}/u,
  Khmer: /\p{scx=Khmer}/u,
  Myanmar: /\p{scx=Myanmar}/u,
  Ethiopic: /\p{scx=Ethiopic}/u,
  Han: /\p{scx=Han}/u,
  Japanese: /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u,
  Hangul: /\p{scx=Hangul}/u,
};

/** Scripts written without spaces between words: n-grams are taken over characters. */
const UNSPACED = new Set<Script>(["Han", "Japanese", "Thai", "Lao", "Khmer", "Myanmar"]);

const BASE_PUNCT = ".,?!:'’-";
const SYMBOLS = "%$€£₹¥₩₽₺₴₸₱₦৳₫฿₾₮₼";
const LETTER = /[\p{L}\p{M}]/u;
const INHERITED = /\p{Script=Inherited}/u;
const COMMON = /\p{Script=Common}/u;
const LATIN = /\p{Script=Latin}/u;
const CAMEL_BRANDS = new Set(("whatsapp youtube iphone ipad imac ios macos macbook airpods phonepe paytm gpay paypal linkedin " +
  "powerpoint onedrive onenote sharepoint mcdonald mcdonalds bigbasket jiomart jiocinema makemytrip bookmytrip bookmyshow " +
  "indigo spicejet oneplus firstcry policybazaar easemytrip redbus olx myntra nykaa swiggyinstamart instamart tiktok " +
  "chatgpt openai wechat alipay kakaotalk navermap linepay grabfood foodpanda gojek tokopedia shopee lazada " +
  "playstation xbox appstore playstore googlepay applepay facetime icloud gmail hotmail dropbox wetransfer " +
  "deliveroo justeat ubereats doordash airbnb booking.com tripadvisor skyscanner rapido careem talabat noon " +
  "hungerstation jahez carrefour lulu ikea zara hm decathlon").split(" "));

export function basic(s: string) {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}\s']/gu, " ")
    .replace(/(?<![\p{L}\p{N}])'|'(?![\p{L}\p{N}])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Port of python/core textnorm.fuzzy: forgives the spelling variants of romanized Indic text.
const RULES: [string, string][] = [["chh", "ch"], ["ksh", "x"], ["sh", "s"], ["ph", "f"], ["aa", "a"], ["ee", "i"],
  ["ii", "i"], ["oo", "u"], ["uu", "u"], ["w", "v"], ["z", "j"], ["y", "i"], ["q", "k"]];
export function fuzzy(s: string) {
  let t = basic(s).replace(/'/g, "");
  for (const [a, b] of RULES) t = t.split(a).join(b);
  t = t.replace(/([a-z])\1+/g, "$1").replace(/h\b/g, "").replace(/(?<=[bcdgjkpt])h/g, "");
  return t.replace(/\s+/g, " ").trim();
}

function speechChars(text: string, cjk: boolean) {
  let n = 0;
  for (const ch of text) {
    if (/\d/.test(ch)) n += cjk ? 1 : 2.5; // numbers are read as words
    else if (LETTER.test(ch) || ch === " ") n += INHERITED.test(ch) && !cjk ? 0.5 : 1;
  }
  return n;
}

/** Estimated seconds to read one line aloud. */
export function lineSeconds(p: Profile, item: Item, i: number) {
  const text = p.rateOn === "roman" && item.roman ? item.roman[i]! : item.native[i]!;
  const cjk = p.rateOn === "native" && UNSPACED.has(p.script);
  return speechChars(text, cjk) / p.rate;
}

/** Estimated seconds to read an item, including the pauses at line breaks. */
export function itemSeconds(p: Profile, item: Item) {
  let s = 0;
  for (let i = 0; i < item.native.length; i++) s += lineSeconds(p, item, i) + BOUNDS.pauseBetweenLines;
  return s;
}

const numbers = (s: string) => (s.match(/\d+(?:[.,:]\d+)*/g) ?? []).map((n) => n.replace(/[.,:]/g, "")).sort();
const standaloneNumbers = (s: string) =>
  (s.match(/(?<![\p{L}\d])\d+(?:[.,:]\d+)*(?![\p{L}\d])/gu) ?? []).map((n) => n.replace(/[.,:]/g, "")).sort();

function lineIssues(p: Profile, line: string, roman: boolean): string[] {
  const issues: string[] = [];
  if (line !== line.trim() || /\s{2,}|[\t\n]/.test(line)) issues.push("stray whitespace");
  if (!line.trim()) return ["empty line"];
  const allowed = BASE_PUNCT + SYMBOLS + (roman ? "" : p.punct ?? "");
  let native = 0, latin = 0;
  const bad = new Set<string>();
  for (const ch of line) {
    if (ch === " " || /[0-9]/.test(ch) || allowed.includes(ch)) continue;
    if (!roman && (ch === "‌" || ch === "‍")) continue; // ZWNJ/ZWJ (Persian, Sinhala, Indic)
    if (/\p{Nd}/u.test(ch)) { bad.add(ch); continue; } // native-script digits: write 0-9
    if (!LETTER.test(ch)) { bad.add(ch); continue; }
    if (INHERITED.test(ch)) continue; // combining marks
    if (roman) {
      if (!LATIN.test(ch) && !COMMON.test(ch)) bad.add(ch);
      else if (!p.romanDiacritics && LATIN.test(ch) && !/[A-Za-z]/.test(ch)) bad.add(ch);
      continue;
    }
    if (p.script !== "Latin" && SCRIPT_RE[p.script].test(ch)) native++;
    else if (LATIN.test(ch)) latin++;
    else if (!COMMON.test(ch)) bad.add(ch);
  }
  if (bad.size) issues.push(`characters not allowed in ${roman ? "the romanized" : "the native"} line: ${[...bad].join(" ")}`);
  if (!roman && p.script !== "Latin") {
    const share = latin / Math.max(1, native + latin);
    if (native === 0) issues.push(`native line has no ${p.script} letters`);
    else if (share > p.latinInNative) issues.push(`native line is ${Math.round(share * 100)}% Latin letters (max ${Math.round(p.latinInNative * 100)}%)`);
  }
  if (/([.,?!:])\1/.test(line) && !/\d[.,:]\d/.test(line)) issues.push("repeated punctuation");
  if (roman) {
    // Casual typing never marks sounds with capitals inside words (paDosan, ArUN); brand names may.
    const odd = line.split(/[^\p{L}']+/u).filter((w) => /\p{Ll}\p{Lu}/u.test(w) && !CAMEL_BRANDS.has(w.replace(/'s$/, "").toLowerCase()));
    if (odd.length) issues.push(`capital letters inside words in the romanized line: ${odd.join(" ")} (only brand names like WhatsApp keep them)`);
  }
  return issues;
}

/** Checks that look at one item alone. */
export function itemIssues(p: Profile, item: Item): string[] {
  const issues: string[] = [];
  const n = item.native.length;
  if (!n) return ["no lines"];
  if (p.roman) {
    if (!item.roman) issues.push("romanized version missing");
    else if (item.roman.length !== n) issues.push(`romanized has ${item.roman.length} lines, native has ${n}`);
  } else if (item.roman) issues.push("romanized version given for a Latin-script language");
  if (item.kind === "sentence" && n !== 1) issues.push("a sentence item must be exactly one line");
  if (item.kind === "para") {
    if (!item.title?.trim()) issues.push("passage has no title");
    const [lo, hi] = BOUNDS.para.lines;
    if (n < lo || n > hi) issues.push(`passage has ${n} lines (want ${lo}-${hi})`);
    const s = itemSeconds(p, item);
    if (s < BOUNDS.para.min || s > BOUNDS.para.max) issues.push(`passage reads in about ${Math.round(s)} s (want ${BOUNDS.para.min}-${BOUNDS.para.max})`);
  }
  const b = item.kind === "para" ? BOUNDS.paraLine : BOUNDS.sentence;
  item.native.forEach((line, i) => {
    for (const x of lineIssues(p, line, false)) issues.push(`line ${i + 1}: ${x}`);
    const r = item.roman?.[i];
    if (p.roman && r !== undefined) {
      for (const x of lineIssues(p, r, true)) issues.push(`line ${i + 1} roman: ${x}`);
      const a = numbers(line).join(" ");
      const c = (p.code === "ar" ? standaloneNumbers(r) : numbers(r)).join(" ");
      if (a !== c) issues.push(`line ${i + 1}: numbers differ between native (${a || "none"}) and roman (${c || "none"})`);
    }
    const s = p.roman && !item.roman ? 0 : lineSeconds(p, item, i);
    if (s && (s < b.min || s > b.max)) issues.push(`line ${i + 1} reads in about ${s.toFixed(1)} s (want ${b.min}-${b.max})`);
  });
  return issues;
}

function grams(text: string, unspaced: boolean, n: number): string[] {
  if (unspaced) {
    const c = [...text.replace(/\s/g, "")];
    const out: string[] = [];
    for (let i = 0; i + n <= c.length; i++) out.push(c.slice(i, i + n).join(""));
    return out;
  }
  const w = text.split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" "));
  return out;
}

/**
 * Index of the test clips' n-grams. Word 3-grams on basic and fuzzy normalization (so a romanized
 * spelling variant still matches), and character n-grams for scripts written without spaces.
 */
export class TestIndex {
  private words = new Set<string>();
  private chars = new Set<string>();
  constructor(texts: string[]) {
    for (const t of texts) {
      for (const g of grams(basic(t), false, 3)) this.words.add(g);
      for (const g of grams(fuzzy(t), false, 3)) this.words.add("~" + g);
      for (const g of grams(basic(t), true, 6)) this.chars.add(g);
    }
  }
  get size() {
    return this.words.size;
  }
  /** Test n-grams the line shares (empty when clean). */
  overlap(line: string, unspaced: boolean): string[] {
    const hits = new Set<string>();
    for (const g of grams(basic(line), false, 3)) if (this.words.has(g)) hits.add(g);
    if (/[a-z]/i.test(line)) for (const g of grams(fuzzy(line), false, 3)) if (this.words.has("~" + g)) hits.add(g);
    if (unspaced) for (const g of grams(basic(line), true, 6)) if (this.chars.has(g)) hits.add(g);
    return [...hits];
  }
}

export function testIssues(p: Profile, item: Item, index: TestIndex): string[] {
  const out: string[] = [];
  const unspaced = UNSPACED.has(p.script);
  item.native.forEach((l, i) => {
    const hits = [...index.overlap(l, unspaced), ...(item.roman?.[i] ? index.overlap(item.roman[i]!, false) : [])];
    if (hits.length) out.push(`line ${i + 1} shares wording with a held-back test clip`);
  });
  return out;
}

function shingles(text: string, unspaced: boolean) {
  const t = basic(text);
  const s = new Set<string>();
  const c = [...(unspaced ? t.replace(/\s/g, "") : t)];
  const n = unspaced ? 2 : 3;
  for (let i = 0; i + n <= c.length; i++) s.add(c.slice(i, i + n).join(""));
  return s;
}

/**
 * Duplicates and near-duplicates across a language's lines (character-shingle Jaccard). The item listed
 * later is the one flagged, so earlier work survives.
 */
export function duplicateIssues(p: Profile, items: Item[], threshold = 0.6): Map<string, string[]> {
  const unspaced = UNSPACED.has(p.script);
  const lines: { id: string; i: number; key: string; sh: Set<string> }[] = [];
  for (const it of items)
    it.native.forEach((l, i) => lines.push({ id: it.id, i, key: basic(l), sh: shingles(l, unspaced) }));
  const out = new Map<string, string[]>();
  const flag = (id: string, msg: string) => out.set(id, [...(out.get(id) ?? []), msg]);
  for (let b = 0; b < lines.length; b++) {
    const B = lines[b]!;
    for (let a = 0; a < b; a++) {
      const A = lines[a]!;
      if (A.id === B.id && A.i === B.i) continue;
      if (A.key === B.key) { flag(B.id, `line ${B.i + 1} duplicates ${A.id} line ${A.i + 1}`); break; }
      let inter = 0;
      const [small, big] = A.sh.size < B.sh.size ? [A.sh, B.sh] : [B.sh, A.sh];
      for (const g of small) if (big.has(g)) inter++;
      const j = inter / (A.sh.size + B.sh.size - inter || 1);
      if (j >= threshold) { flag(B.id, `line ${B.i + 1} nearly duplicates ${A.id} line ${A.i + 1}`); break; }
    }
  }
  return out;
}

/** Words of the romanized lines that are spelled more than one way (same fuzzy key). */
export function romanVariants(items: Item[]): { key: string; spellings: Record<string, number> }[] {
  const groups = new Map<string, Map<string, number>>();
  for (const it of items)
    for (const l of it.roman ?? [])
      for (const w of basic(l).split(" ")) {
        if (!/^[a-z']+$/.test(w) || w.length < 2) continue;
        const k = fuzzy(w);
        const g = groups.get(k) ?? new Map<string, number>();
        g.set(w, (g.get(w) ?? 0) + 1);
        groups.set(k, g);
      }
  return [...groups]
    .filter(([, g]) => g.size > 1)
    .map(([key, g]) => ({ key, spellings: Object.fromEntries([...g].sort((a, b) => b[1] - a[1])) }))
    .sort((a, b) => Object.values(b.spellings).reduce((x, y) => x + y) - Object.values(a.spellings).reduce((x, y) => x + y));
}

/**
 * Near-duplicate index for large pools (thousands of lines): an inverted index from character shingles to
 * lines, so each lookup only compares lines that share uncommon shingles.
 */
export class DupIndex {
  private lines: { key: string; sh: Set<string> }[] = [];
  private post = new Map<string, number[]>();
  private keys = new Set<string>();
  constructor(private p: Profile, private threshold = 0.6) {}
  private sh(line: string) {
    return shingles(line, UNSPACED.has(this.p.script));
  }
  /** Index of an earlier line this one duplicates or nearly duplicates, or -1. */
  find(line: string): number {
    const key = basic(line);
    if (this.keys.has(key)) return this.lines.findIndex((l) => l.key === key);
    const sh = this.sh(line);
    const counts = new Map<number, number>();
    for (const g of sh) {
      const list = this.post.get(g);
      if (!list || list.length > 400) continue; // very common shingles say little
      for (const i of list) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    for (const [i] of counts) {
      const other = this.lines[i]!.sh;
      let inter = 0;
      for (const g of sh) if (other.has(g)) inter++;
      if (inter / (sh.size + other.size - inter || 1) >= this.threshold) return i;
    }
    return -1;
  }
  add(line: string) {
    const i = this.lines.length;
    const sh = this.sh(line);
    this.lines.push({ key: basic(line), sh });
    this.keys.add(basic(line));
    for (const g of sh) {
      const list = this.post.get(g) ?? [];
      list.push(i);
      this.post.set(g, list);
    }
  }
  get size() {
    return this.lines.length;
  }
}
