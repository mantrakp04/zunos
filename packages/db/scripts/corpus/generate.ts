#!/usr/bin/env bun
/**
 * Generates zunos's reading corpus with an LLM: packages/db/corpus/<code>.json for every target language
 * (langs.ts). Each file holds passages (read in one take, cut into clips at line breaks) and dictation-style
 * sentences, about 20 minutes of reading. Languages not written in Latin script carry every line twice:
 * native script and the same words typed casually in English letters.
 *
 * Pipeline per language: style guide (brief) → passages → sentences until the reading time is reached →
 * automated checks (scripts, alignment, lengths, punctuation, duplicates, overlap with the held-back test
 * clips) with repairs → native-editor review (fix or drop, replacements reviewed again, up to 3 rounds) →
 * diversity review → romanized spelling consistency → reading-time balance → final checks → starter set
 * (about 5.5 minutes chosen for coverage of sounds, frequent words, numbers, names and English mixing; see
 * starter.ts) → write { lang, starter: [ids in reading order], items }.
 *
 * Usage (from the repo root):
 *   bun packages/db/scripts/corpus/generate.ts --pilot          # en hi gu ar ja ta
 *   bun packages/db/scripts/corpus/generate.ts --langs hi,gu
 *   bun packages/db/scripts/corpus/generate.ts --all
 *   bun packages/db/scripts/corpus/generate.ts --langs hi --starter-only   # recompute the starter set
 *   bun packages/db/scripts/corpus/generate.ts --all --verify              # re-run the checks on the files
 *
 * Environment (defaults in brackets):
 *   CORPUS_LLM_URL      OpenAI-compatible server [http://127.0.0.1:8317, the local VibeProxy]
 *   CORPUS_MODEL        model id [gpt-6.1-sol]; CORPUS_REVIEW_MODEL for the reviews [same]
 *   CORPUS_API_KEY      bearer token if the server needs one [none; VibeProxy on localhost does not]
 *   CORPUS_REASONING    reasoning effort [high]
 *   CORPUS_CONCURRENCY  parallel LLM requests [6]; CORPUS_LANGS_PARALLEL languages at once [4]
 *   CORPUS_TARGET_MIN   reading minutes per language [20]
 *   CORPUS_CACHE        cache of LLM answers and work state, which makes runs resumable [./.cache]
 *   ZUNOS_DB            app database with the test clips [~/Library/Application Support/zunos/zunos.db]
 *
 * Every LLM answer is cached by request, so an interrupted run picks up where it stopped. Corpus text never
 * shares a word 3-gram with a test clip (split='test'); test text is read at runtime and never sent to the LLM.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { duplicateIssues, type Item, itemIssues, TestIndex, testIssues } from "./checks";
import { PROFILES, type Profile, profile } from "./langs";
import { askJson, CACHE_DIR, REVIEW_MODEL, stats } from "./llm";
import { clean, getBrief, ideas, lines, loadTestTexts, log, OUT_DIR, parseItem, respell, rng, seconds, shuffle } from "./common";
import { selectStarter, tagItems } from "./starter";
import {
  type Brief, CATEGORIES, diversityPrompt, PASSAGE_SLOTS, passagesPrompt, repairPrompt, reviewPrompt,
  sentencesPrompt,
} from "./prompts";

const STATE_DIR = join(CACHE_DIR, "state");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

const TARGET = Number(process.env.CORPUS_TARGET_MIN ?? 20) * 60;
const LOW = TARGET - 60, HIGH = TARGET + 90;
const PILOT = ["en", "hi", "gu", "ar", "ja", "ta"];
const BATCH = 16; // sentences per generation call
const REVIEW_BATCH = 24;

type Work = Item & {
  cat?: string; // sentence category
  slot?: number; // passage slot
  reviewed?: boolean;
  scores?: Record<string, number>;
  problems?: string;
  origin: string; // how it was made, for the report
};

const asItem = (w: Work): Item => ({ id: w.id, kind: w.kind, ...(w.title ? { title: w.title } : {}), native: w.native, roman: w.roman });

class Lang {
  items: Work[] = [];
  private n = { p: 0, s: 0 };
  private r: () => number;
  report: Record<string, any> = { reviewRounds: [], repairs: 0, droppedByChecks: 0, droppedByReview: 0, droppedForDiversity: 0, testOverlapDrops: 0, spellingFixes: 0 };

  constructor(readonly p: Profile, readonly b: Brief, readonly tests: TestIndex) {
    this.r = rng(`corpus-${p.code}`);
  }

  private save(stage: string) {
    writeFileSync(join(STATE_DIR, `${this.p.code}.json`), JSON.stringify({ stage, report: this.report, items: this.items }, null, 1));
  }

  async passages(slots: number[], previous: Work[], round: string) {
    const p = this.p;
    const assign = slots.map((s) => ({ register: PASSAGE_SLOTS[s]!.register, topic: shuffle(this.r, PASSAGE_SLOTS[s]!.topics)[0]! }));
    const msgs = passagesPrompt(p, this.b, assign, ideas(this.r, this.b), previous);
    const out = await askJson(msgs, (x) => {
      if (!Array.isArray(x.passages) || x.passages.length !== slots.length) throw new Error(`expected ${slots.length} passages`);
      return x.passages.map((y: any) => ({ title: clean(y.title), ...parseItem(p, y, "para") }));
    }, { tag: `${p.code}-passages-${round}` });
    return out.map((y: any, i: number): Work => ({ id: `p${String(++this.n.p).padStart(2, "0")}`, kind: "para", slot: slots[i], origin: round, ...y }));
  }

  async sentences(cat: (typeof CATEGORIES)[number], n: number, guidance: string, round: string) {
    const p = this.p;
    const existing = this.items.filter((x) => x.kind === "sentence").map((x) => x.native[0]!);
    const msgs = sentencesPrompt(p, this.b, cat, n, ideas(this.r, this.b), existing, guidance);
    const out = await askJson(msgs, (x) => {
      if (!Array.isArray(x.sentences) || x.sentences.length < Math.ceil(n * 0.8)) throw new Error(`expected ${n} sentences`);
      return x.sentences.map((y: any) => parseItem(p, y, "sentence"));
    }, { tag: `${p.code}-sent-${cat.key}-${round}` });
    return out.map((y: any): Work => ({ id: `s${String(++this.n.s).padStart(3, "0")}`, kind: "sentence", cat: cat.key, origin: round, ...y }));
  }

  /** Automated checks on all items; repair what can be repaired, drop the rest. */
  async enforce(stage: string) {
    const p = this.p;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dups = duplicateIssues(p, this.items);
      const bad: { item: Work; issues: string[] }[] = [];
      for (const it of this.items) {
        if (testIssues(p, it, this.tests).length) {
          // Never shown to the LLM: the item is dropped and written afresh.
          this.items = this.items.filter((x) => x !== it);
          this.report.testOverlapDrops++;
          log(p, `dropped ${it.id}: shares wording with a test clip`);
          continue;
        }
        const issues = [...itemIssues(p, it), ...(dups.get(it.id) ?? [])];
        if (issues.length) bad.push({ item: it, issues });
      }
      if (!bad.length) return;
      if (attempt === 3) {
        for (const { item, issues } of bad) log(p, `dropped ${item.id} after repairs: ${issues.join("; ")}`);
        this.report.droppedByChecks += bad.length;
        this.items = this.items.filter((x) => !bad.some((b) => b.item === x));
        return;
      }
      // Duplicates are not worth repairing: drop the later copy.
      const dupOnly = bad.filter((b) => b.issues.every((i) => i.includes("duplicates")));
      this.items = this.items.filter((x) => !dupOnly.some((b) => b.item === x));
      this.report.droppedByChecks += dupOnly.length;
      const fix = bad.filter((b) => !dupOnly.includes(b));
      if (!fix.length) continue;
      log(p, `repairing ${fix.length} items (${stage}, attempt ${attempt})`);
      const chunks: (typeof fix)[] = [];
      for (let i = 0; i < fix.length; i += 12) chunks.push(fix.slice(i, i + 12));
      await Promise.all(chunks.map(async (chunk, ci) => {
        const ans = await askJson(repairPrompt(p, this.b, chunk), (x) => {
          if (!Array.isArray(x.items)) throw new Error(`expected "items"`);
          return x.items.map((y: any) => ({ id: clean(y.id), native: lines(y.native), roman: p.roman ? lines(y.roman) : null }));
        }, { tag: `${p.code}-repair-${stage}-${attempt}-${ci}` });
        for (const a of ans) {
          const w = this.items.find((x) => x.id === a.id);
          if (!w) continue;
          w.native = a.native;
          w.roman = a.roman;
          w.reviewed = false;
          this.report.repairs++;
        }
      }));
    }
  }

  /** One review pass over unreviewed items: keep, apply fixes (re-reviewed next round), or drop. */
  async review(round: number) {
    const p = this.p;
    const todo = this.items.filter((x) => !x.reviewed);
    if (!todo.length) return { dropped: [] as Work[], ok: 0, fixed: 0 };
    const chunks: Work[][] = [];
    const paras = todo.filter((x) => x.kind === "para"), sents = todo.filter((x) => x.kind === "sentence");
    for (let i = 0; i < paras.length; i += 3) chunks.push(paras.slice(i, i + 3));
    for (let i = 0; i < sents.length; i += REVIEW_BATCH) chunks.push(sents.slice(i, i + REVIEW_BATCH));
    const dropped: Work[] = [];
    let ok = 0, fixed = 0;
    const last = round === 3;
    await Promise.all(chunks.map(async (chunk, ci) => {
      const ans = await askJson(reviewPrompt(p, this.b, chunk.map((w) => ({ ...asItem(w), note: w.cat }))), (x) => {
        if (!Array.isArray(x.reviews)) throw new Error(`expected "reviews"`);
        const byId = new Map<string, any>(x.reviews.map((r: any) => [String(r.id), r]));
        for (const w of chunk) {
          const r = byId.get(w.id);
          if (!r) throw new Error(`no review for ${w.id}`);
          if (!["ok", "fix", "drop"].includes(r.verdict)) throw new Error(`bad verdict for ${w.id}`);
          if (r.verdict === "fix") {
            if (!r.fixed) throw new Error(`verdict fix for ${w.id} needs "fixed"`);
            const f = parseItem(p, r.fixed, w.kind);
            if (f.native.length !== w.native.length && w.kind === "sentence") throw new Error(`fixed ${w.id} changed the line count`);
          }
        }
        return byId;
      }, { tag: `${p.code}-review-r${round}-${ci}-${chunk[0]!.id}`, model: REVIEW_MODEL });
      for (const w of chunk) {
        const r = ans.get(w.id)!;
        const scores: Record<string, number> = {};
        for (const k of ["natural", "correct", "roman", "fit", "local"]) if (typeof r[k] === "number") scores[k] = r[k];
        w.scores = scores;
        w.problems = r.problems || "";
        const min = Math.min(...Object.values(scores));
        if (r.verdict === "ok" && min >= 4) {
          w.reviewed = true;
          ok++;
        } else if (r.verdict === "fix" || (r.verdict === "ok" && min >= 3)) {
          if (r.verdict === "ok") {
            // Passed with a weak score and no fix offered: ask again next round, drop in the last.
            if (last) dropped.push(w);
            continue;
          }
          const f = parseItem(p, r.fixed, w.kind);
          w.native = f.native;
          w.roman = f.roman;
          w.origin += "+fix";
          w.reviewed = last; // the last round's fixes are accepted if they pass the automated checks
          fixed++;
        } else dropped.push(w);
      }
    }));
    this.items = this.items.filter((x) => !dropped.includes(x));
    return { dropped, ok, fixed };
  }

  /** Write replacements for dropped items: same category or passage slot, guided by the editor's notes. */
  async replace(dropped: Work[], round: string, extra = "") {
    const paras = dropped.filter((x) => x.kind === "para");
    if (paras.length) {
      const fresh = await this.passages(paras.map((x) => x.slot!), this.items.filter((x) => x.kind === "para"), round);
      this.items.push(...fresh);
    }
    const byCat = new Map<string, Work[]>();
    for (const w of dropped.filter((x) => x.kind === "sentence")) byCat.set(w.cat!, [...(byCat.get(w.cat!) ?? []), w]);
    for (const [key, ws] of byCat) {
      const cat = CATEGORIES.find((c) => c.key === key)!;
      const notes = ws.map((w) => w.problems).filter(Boolean).slice(0, 8);
      const guidance = [extra, notes.length ? `An editor rejected earlier attempts for these reasons; avoid the same problems: ${notes.join(" | ")}` : ""].filter(Boolean).join(" ");
      this.items.push(...(await this.sentences(cat, Math.max(ws.length, 3), guidance, round)));
    }
  }

  /** Write a passage again for any slot that lost its passage (to a check, a test-clip overlap or a review). */
  async restorePassages(tag: string) {
    const have = new Set(this.items.filter((x) => x.kind === "para").map((x) => x.slot));
    const missing = PASSAGE_SLOTS.map((_, i) => i).filter((i) => !have.has(i));
    if (missing.length) this.items.push(...(await this.passages(missing, this.items.filter((x) => x.kind === "para"), `${tag}-restore`)));
  }

  async reviewLoop(tag: string) {
    for (let round = 1; round <= 3; round++) {
      if (round < 3) await this.restorePassages(`${tag}-r${round}`);
      await this.enforce(`${tag}-r${round}`);
      const res = await this.review(round);
      this.report.reviewRounds.push({ tag, round, ok: res.ok, fixed: res.fixed, dropped: res.dropped.length });
      this.report.droppedByReview += res.dropped.length;
      log(this.p, `review ${tag} round ${round}: ${res.ok} ok, ${res.fixed} fixed, ${res.dropped.length} dropped`);
      if (res.dropped.length && round < 3) await this.replace(res.dropped, `${tag}-repl${round}`);
      if (!this.items.some((x) => !x.reviewed)) break;
    }
    await this.enforce(`${tag}-final`);
    // Anything still unreviewed after three rounds is not shipped.
    const left = this.items.filter((x) => !x.reviewed);
    if (left.length) log(this.p, `dropping ${left.length} items never approved`);
    this.items = this.items.filter((x) => x.reviewed);
    this.save(tag);
  }

  /** Sentences each category should end with: its weight's share of the sentences the reading time needs. */
  private categoryDeficits() {
    const sents = this.items.filter((x) => x.kind === "sentence");
    const paraSecs = seconds(this.p, this.items.filter((x) => x.kind === "para"));
    const avg = sents.length >= 10 ? seconds(this.p, sents) / sents.length : 5;
    const planned = Math.max(sents.length + 1, Math.round((TARGET - paraSecs) / avg));
    const total = CATEGORIES.reduce((s, c) => s + c.weight, 0);
    return CATEGORIES.map((c) => ({ c, deficit: (c.weight / total) * planned - sents.filter((x) => x.cat === c.key).length }))
      .sort((a, b) => b.deficit - a.deficit);
  }

  async fill(tag: string) {
    let k = 0;
    while (seconds(this.p, this.items) < TARGET && k++ < 40) {
      const { c, deficit } = this.categoryDeficits()[0]!;
      const n = Math.min(BATCH, Math.max(6, Math.ceil(deficit)));
      this.items.push(...(await this.sentences(c, n, "", `${tag}${k}`)));
      await this.enforce(`${tag}${k}`);
    }
  }

  async diversity() {
    const p = this.p;
    const maxDrop = Math.round(this.items.length * 0.12);
    const ans = await askJson(diversityPrompt(p, this.b, this.items.map(asItem), maxDrop), (x) => {
      if (!Array.isArray(x.drop)) throw new Error(`expected "drop"`);
      return { drop: x.drop.map((d: any) => ({ id: clean(d.id), reason: clean(d.reason ?? "") })), guidance: clean(x.guidance ?? "") };
    }, { tag: `${p.code}-diversity`, model: REVIEW_MODEL });
    const ids = new Set(ans.drop.slice(0, maxDrop).map((d: { id: string }) => d.id));
    const dropped = this.items.filter((x) => ids.has(x.id) && x.kind === "sentence");
    this.items = this.items.filter((x) => !dropped.includes(x));
    this.report.droppedForDiversity = dropped.length;
    this.report.diversityGuidance = ans.guidance;
    log(p, `diversity: replacing ${dropped.length} items`);
    if (dropped.length) await this.replace(dropped, "div", ans.guidance);
    await this.reviewLoop("div");
  }

  async spelling() {
    const p = this.p;
    if (!p.roman) return;
    const { groups, changed } = await respell(p, this.b, this.items, `${p.code}-spelling`, 150);
    this.report.spellingFixes = changed;
    log(p, `spelling: ${groups} variant groups, ${changed} words respelled`);
  }

  /** Trim to the reading-time window by dropping the weakest sentences of over-represented categories. */
  trim() {
    const score = (w: Work) => Object.values(w.scores ?? {}).reduce((a, b) => a + b, 0);
    while (seconds(this.p, this.items) > HIGH) {
      const over = this.categoryDeficits().at(-1)!.c.key;
      const pool = this.items.filter((x) => x.kind === "sentence" && x.cat === over).sort((a, b) => score(a) - score(b));
      if (!pool.length) break;
      this.items = this.items.filter((x) => x !== pool[0]);
    }
  }

  result() {
    const p = this.p;
    const paras = this.items.filter((x) => x.kind === "para").sort((a, b) => a.slot! - b.slot!);
    // Interleave sentence categories so reading in order moves between kinds of speech.
    const byCat = CATEGORIES.map((c) => shuffle(rng(`order-${p.code}-${c.key}`), this.items.filter((x) => x.kind === "sentence" && x.cat === c.key)));
    const sents: Work[] = [];
    for (let i = 0; byCat.some((q) => q.length); i++) {
      const q = byCat[i % byCat.length]!;
      if (q.length) sents.push(q.shift()!);
    }
    const items: Item[] = [
      ...paras.map((w, i) => ({ id: `${p.code}-p${String(i + 1).padStart(2, "0")}`, kind: "para" as const, title: w.title!, native: w.native, roman: w.roman })),
      ...sents.map((w, i) => ({ id: `${p.code}-s${String(i + 1).padStart(3, "0")}`, kind: "sentence" as const, native: w.native, roman: w.roman })),
    ];
    return items;
  }
}

async function build(p: Profile, tests: TestIndex) {
  const t0 = Date.now();
  const b = await getBrief(p);
  writeFileSync(join(STATE_DIR, `${p.code}.brief.json`), JSON.stringify(b, null, 1));
  if (process.argv.includes("--brief-only")) return { lang: p.code, briefOnly: true };
  const L = new Lang(p, b, tests);
  log(p, "brief ready; writing passages");
  const slots = PASSAGE_SLOTS.map((_, i) => i);
  L.items.push(...(await L.passages(slots.slice(0, 4), [], "pa")));
  L.items.push(...(await L.passages(slots.slice(4), L.items, "pb")));
  await L.enforce("passages");
  await L.fill("fill");
  log(p, `drafted ${L.items.length} items, ~${(seconds(p, L.items) / 60).toFixed(1)} min; reviewing`);
  await L.reviewLoop("main");
  await L.diversity();
  await L.spelling();
  await L.enforce("spelling");
  for (let k = 0; k < 2 && seconds(p, L.items) < LOW; k++) {
    await L.fill(`top${k}-`);
    await L.reviewLoop(`top${k}`);
  }
  L.trim();

  // Final gate: every shipped item passes every automated check.
  const items = L.result();
  const dups = duplicateIssues(p, items);
  const problems = items.flatMap((it) => [...itemIssues(p, it), ...testIssues(p, it, tests), ...(dups.get(it.id) ?? [])].map((x) => `${it.id}: ${x}`));
  if (problems.length) throw new Error(`[${p.code}] final check failed:\n${problems.join("\n")}`);

  const starter = await writeCorpus(p, items);
  const scored = L.items.filter((w) => w.scores);
  const avg = (k: string) => {
    const v = scored.map((w) => w.scores![k]).filter((x): x is number => typeof x === "number");
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
  };
  const summary = {
    lang: p.code, name: p.name,
    passages: items.filter((x) => x.kind === "para").length,
    sentences: items.filter((x) => x.kind === "sentence").length,
    minutes: +(seconds(p, items) / 60).toFixed(1),
    passageMinutes: +(seconds(p, items.filter((x) => x.kind === "para")) / 60).toFixed(1),
    starter: starter.stats,
    scores: { natural: avg("natural"), correct: avg("correct"), roman: avg("roman"), fit: avg("fit"), local: avg("local") },
    vocabulary: (() => {
      const words = items.flatMap((x) => (x.roman ?? x.native).join(" ").toLowerCase().split(/[^\p{L}\p{M}']+/u)).filter(Boolean);
      return { tokens: words.length, types: new Set(words).size };
    })(),
    categories: Object.fromEntries(CATEGORIES.map((c) => [c.key, L.items.filter((x) => x.cat === c.key).length])),
    ...L.report,
    wallMinutes: +((Date.now() - t0) / 60000).toFixed(1),
  };
  writeFileSync(join(STATE_DIR, `${p.code}.summary.json`), JSON.stringify(summary, null, 1));
  log(p, `done: ${summary.passages} passages, ${summary.sentences} sentences, ~${summary.minutes} min`);
  return summary;
}

/** Pick the starter set and write packages/db/corpus/<code>.json. */
async function writeCorpus(p: Profile, items: Item[]) {
  const starter = selectStarter(p, items, await tagItems(p, items));
  writeFileSync(join(OUT_DIR, `${p.code}.json`), JSON.stringify({ lang: p.code, starter: starter.ids, items }, null, 2) + "\n");
  log(p, `starter: ${JSON.stringify(starter.stats)}`);
  return starter;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let codes: string[];
  if (args.includes("--all")) codes = PROFILES.map((p) => p.code);
  else if (args.includes("--pilot")) codes = PILOT;
  else if (flag("--langs")) codes = flag("--langs")!.split(",").map((s) => s.trim());
  else {
    console.error("usage: generate.ts --pilot | --all | --langs en,hi");
    process.exit(1);
  }
  const profiles = codes.map(profile);
  if (args.includes("--starter-only")) {
    // Recompute the starter set of existing corpus files.
    for (const p of profiles) {
      const file = join(OUT_DIR, `${p.code}.json`);
      if (!existsSync(file)) continue;
      const data = JSON.parse(await Bun.file(file).text());
      await writeCorpus(p, data.items);
    }
    return;
  }
  const tests = new TestIndex(loadTestTexts());
  if (args.includes("--verify")) {
    // Re-run every automated check on the written files (no LLM calls).
    let bad = 0;
    for (const p of profiles) {
      const file = join(OUT_DIR, `${p.code}.json`);
      if (!existsSync(file)) { console.log(`${p.code}: missing`); bad++; continue; }
      const data = JSON.parse(await Bun.file(file).text()) as { lang: string; starter: string[]; items: Item[] };
      const ids = new Set(data.items.map((x) => x.id));
      const dups = duplicateIssues(p, data.items);
      const problems = [
        ...(data.lang === p.code ? [] : ["wrong lang"]),
        ...(ids.size === data.items.length ? [] : ["duplicate ids"]),
        ...data.starter.filter((id) => !ids.has(id)).map((id) => `starter id ${id} not in items`),
        ...data.items.flatMap((it) => [...itemIssues(p, it), ...testIssues(p, it, tests), ...(dups.get(it.id) ?? [])].map((x) => `${it.id}: ${x}`)),
      ];
      const starterSecs = seconds(p, data.items.filter((x) => data.starter.includes(x.id)));
      console.log(`${p.code}: ${data.items.length} items, ~${(seconds(p, data.items) / 60).toFixed(1)} min, starter ${data.starter.length} items ~${(starterSecs / 60).toFixed(1)} min${problems.length ? `, ${problems.length} problems:\n  ${problems.join("\n  ")}` : ", ok"}`);
      if (problems.length) bad++;
    }
    process.exit(bad ? 2 : 0);
  }
  console.log(`test clips index: ${tests.size} word 3-grams; languages: ${codes.join(" ")}`);

  const parallel = Number(process.env.CORPUS_LANGS_PARALLEL ?? 4);
  const queue = [...profiles];
  const done: any[] = [], failed: string[] = [];
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        done.push(await build(p, tests));
      } catch (e) {
        failed.push(p.code);
        console.error(`[${p.code}] FAILED: ${(e as Error).message}`);
      }
    }
  }));
  console.log(JSON.stringify({ done: done.length, failed, llm: stats }, null, 1));
  if (failed.length) process.exit(2);
}

await main();
