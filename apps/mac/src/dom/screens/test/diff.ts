// Word-level diff between what was read (reference) and what the model heard (hypothesis).
// Normalization mirrors python/core/textnorm.py (basic + fuzzy) and the language set in
// python/core/scoring.py, so the highlighted errors line up with the scored WER. This is for display
// only: the WER itself always comes from the engine.

const FUZZY_LANGS = new Set(["en", "hi", "gu", "mr", "pa", "bn", "ta", "te", "kn", "ml", "ur", "ne"]);

const RULES: [string, string][] = [
  ["chh", "ch"], ["ksh", "x"], ["sh", "s"], ["ph", "f"], ["aa", "a"], ["ee", "i"], ["ii", "i"], ["oo", "u"],
  ["uu", "u"], ["w", "v"], ["z", "j"], ["y", "i"], ["q", "k"],
];

const WORD = "\\p{L}\\p{N}\\p{M}_";

export function basic(s: string) {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(new RegExp(`[^${WORD}\\s']`, "gu"), " ")
    .replace(new RegExp(`(?<![${WORD}])'|'(?![${WORD}])`, "gu"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fuzzyWord(w: string) {
  let s = w.replace(/'/g, "");
  for (const [a, b] of RULES) s = s.split(a).join(b);
  return s
    .replace(/([a-z])\1+/g, "$1")
    .replace(/h\b/g, "")
    .replace(/(?<=[bcdgjkpt])h/g, "");
}

export const isFuzzyLang = (lang: string) => FUZZY_LANGS.has(lang);

type Tok = { text: string; base: string; key: string };

function tokenize(s: string, lang: string): Tok[] {
  const fuzzy = isFuzzyLang(lang);
  const out: Tok[] = [];
  for (const raw of s.split(/\s+/).filter(Boolean)) {
    const parts = basic(raw).split(" ").filter(Boolean);
    if (!parts.length) {
      // Pure punctuation ("—"): keep it on the previous word so the sentence still reads right.
      if (out.length) out[out.length - 1].text += ` ${raw}`;
      continue;
    }
    for (const p of parts) {
      const key = fuzzy ? fuzzyWord(p) : p;
      if (key) out.push({ text: parts.length === 1 ? raw : p, base: p, key });
    }
  }
  return out;
}

export type Op =
  | { kind: "same"; hyp: string }
  /** Counted as right: the spelling differs only in ways the fuzzy score forgives (chhe = che). */
  | { kind: "variant"; ref: string; hyp: string }
  | { kind: "sub"; ref: string; hyp: string }
  | { kind: "del"; ref: string }
  | { kind: "ins"; hyp: string };

export type Diff = { ops: Op[]; words: number; sub: number; del: number; ins: number; variant: number };

/** Minimum edit alignment (Levenshtein with backtrace) on normalized word keys. */
export function diffWords(ref: string, hyp: string, lang: string): Diff {
  const r = tokenize(ref, lang);
  const h = tokenize(hyp, lang);
  const n = r.length;
  const m = h.length;
  const d: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1].key === h[j - 1].key ? 0 : 1));

  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && r[i - 1].key === h[j - 1].key && d[i][j] === d[i - 1][j - 1]) {
      const same = r[i - 1].base === h[j - 1].base;
      ops.push(same ? { kind: "same", hyp: h[j - 1].text } : { kind: "variant", ref: r[i - 1].text, hyp: h[j - 1].text });
      i--, j--;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      ops.push({ kind: "sub", ref: r[i - 1].text, hyp: h[j - 1].text });
      i--, j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ kind: "del", ref: r[i - 1].text });
      i--;
    } else {
      ops.push({ kind: "ins", hyp: h[j - 1].text });
      j--;
    }
  }
  ops.reverse();
  const count = (k: Op["kind"]) => ops.filter((o) => o.kind === k).length;
  return { ops, words: n, sub: count("sub"), del: count("del"), ins: count("ins"), variant: count("variant") };
}
