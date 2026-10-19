#!/usr/bin/env bun
/**
 * Builds the synthesis pool: packages/db/corpus/<code>.synth.json, thousands of distinct dictation-style
 * lines per language for voice-cloned training speech (one take per line, 1-3 hours per language). It is
 * kept apart from the curated recording library (<code>.json), which must exist first: the pool never
 * repeats or nearly repeats a curated line, never shares wording with a held-back test clip, and passes the
 * same automated checks.
 *
 * Per language: a list of localized everyday situations → batches of lines for a few situations each
 * (in parallel) → automated checks and a scalable near-duplicate index over curated + pool lines → editor
 * review (keep, fix or drop) → more rounds until the target size → romanized spelling consistency → write
 * { lang, items: [{ id, kind: "sentence", native: [line], roman: [line] | null }] }.
 *
 * Usage: bun packages/db/scripts/corpus/synth.ts --pilot | --all | --langs hi,gu
 * Environment: as generate.ts, plus CORPUS_SYNTH_LINES [1500] lines per language,
 * CORPUS_SYNTH_PARALLEL [6] languages at once, CORPUS_SYNTH_REVIEW_EFFORT [medium].
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DupIndex, type Item, itemIssues, TestIndex, testIssues } from "./checks";
import { clean, getBrief, ideas, loadTestTexts, log, OUT_DIR, parseItem, respell, rng, shuffle } from "./common";
import { PROFILES, type Profile, profile } from "./langs";
import { askJson, CACHE_DIR, REVIEW_MODEL, stats } from "./llm";
import { CATEGORIES, reviewPrompt, situationsPrompt, synthPrompt } from "./prompts";

const TARGET = Number(process.env.CORPUS_SYNTH_LINES ?? 1500);
const REVIEW_EFFORT = process.env.CORPUS_SYNTH_REVIEW_EFFORT ?? "medium";
const BATCH = 40; // lines per generation call
const PER_BATCH_SITUATIONS = 12; // about 3 lines per situation keeps each batch varied
const REVIEW_BATCH = 40;
const ROUNDS = 6;
const STATE_DIR = join(CACHE_DIR, "state");
mkdirSync(STATE_DIR, { recursive: true });

type Situation = { category: string; situation: string };

/** Localized situations, one list per category, sized by the category's weight. */
async function situations(p: Profile, b: Awaited<ReturnType<typeof getBrief>>, total: number): Promise<Situation[]> {
  const sum = CATEGORIES.reduce((s, c) => s + c.weight, 0);
  const lists = await Promise.all(CATEGORIES.map((c) => {
    const n = Math.max(10, Math.round((c.weight / sum) * total));
    return askJson(situationsPrompt(p, b, c, n), (x) => {
      if (!Array.isArray(x.situations) || x.situations.length < n * 0.8) throw new Error(`expected ${n} situations`);
      return x.situations.map((s: unknown) => ({ category: c.key, situation: clean(s) }));
    }, { tag: `${p.code}-synth-situations-${c.key}` });
  }));
  return lists.flat();
}

async function build(p: Profile, tests: TestIndex) {
  const t0 = Date.now();
  const curatedFile = join(OUT_DIR, `${p.code}.json`);
  if (!existsSync(curatedFile)) throw new Error(`no curated corpus yet (${curatedFile}); run generate.ts first`);
  const curated = (JSON.parse(await Bun.file(curatedFile).text()) as { items: Item[] }).items;
  const b = await getBrief(p);
  const dup = new DupIndex(p);
  for (const it of curated) for (const l of it.native) dup.add(l);
  const sits = shuffle(rng(`synth-sit-${p.code}`), await situations(p, b, Math.ceil((TARGET * 1.3) / BATCH) * PER_BATCH_SITUATIONS));
  log(p, `synth: ${sits.length} situations; target ${TARGET} lines`);

  const accepted: Item[] = [];
  const report = { generated: 0, droppedByChecks: 0, nearDuplicates: 0, testOverlap: 0, reviewed: 0, ok: 0, fixed: 0, droppedByReview: 0, rounds: 0, spellingFixes: 0 };
  let cursor = 0, serial = 0;
  const curatedLines = curated.filter((x) => x.kind === "sentence").map((x) => x.native[0]!);

  for (let round = 1; round <= ROUNDS && accepted.length < TARGET; round++) {
    report.rounds = round;
    const need = TARGET - accepted.length;
    const batches = Math.max(1, Math.ceil((need * 1.25) / BATCH));
    const r = rng(`synth-${p.code}-r${round}`);
    const plans = Array.from({ length: batches }, (_, j) => {
      const s: Situation[] = [];
      for (let k = 0; k < PER_BATCH_SITUATIONS; k++) s.push(sits[cursor++ % sits.length]!);
      const pool = [...curatedLines, ...accepted.map((x) => x.native[0]!)];
      return { j, s, avoid: shuffle(r, pool).slice(0, 25), pick: ideas(r, b) };
    });
    const answers = await Promise.all(plans.map((pl) =>
      askJson(synthPrompt(p, b, pl.s, BATCH, pl.avoid, pl.pick), (x) => {
        if (!Array.isArray(x.sentences) || x.sentences.length < BATCH * 0.7) throw new Error(`expected ${BATCH} sentences`);
        return x.sentences.map((y: any) => parseItem(p, y, "sentence"));
      }, { tag: `${p.code}-synth-r${round}-b${pl.j}` }).catch((e) => {
        log(p, `synth batch r${round}-b${pl.j} failed: ${(e as Error).message}`);
        return [] as { native: string[]; roman: string[] | null }[];
      })));

    // Automated checks, in batch order so the result does not depend on timing.
    const fresh: Item[] = [];
    for (const ans of answers)
      for (const y of ans) {
        report.generated++;
        const it: Item = { id: `x${++serial}`, kind: "sentence", native: y.native, roman: y.roman };
        if (itemIssues(p, it).length) { report.droppedByChecks++; continue; }
        if (testIssues(p, it, tests).length) { report.testOverlap++; continue; }
        if (dup.find(it.native[0]!) >= 0) { report.nearDuplicates++; continue; }
        dup.add(it.native[0]!);
        fresh.push(it);
      }

    // Editor review: keep, apply small fixes, or drop.
    const chunks: Item[][] = [];
    for (let i = 0; i < fresh.length; i += REVIEW_BATCH) chunks.push(fresh.slice(i, i + REVIEW_BATCH));
    const reviewed = await Promise.all(chunks.map((chunk) =>
      askJson(reviewPrompt(p, b, chunk), (x) => {
        if (!Array.isArray(x.reviews)) throw new Error(`expected "reviews"`);
        const byId = new Map<string, any>(x.reviews.map((v: any) => [String(v.id), v]));
        for (const it of chunk) {
          const v = byId.get(it.id);
          if (!v || !["ok", "fix", "drop"].includes(v.verdict)) throw new Error(`no valid review for ${it.id}`);
          if (v.verdict === "fix") parseItem(p, v.fixed, "sentence");
        }
        return byId;
      }, { tag: `${p.code}-synth-review-r${round}-${chunk[0]!.id}`, model: REVIEW_MODEL, effort: REVIEW_EFFORT }).catch((e) => {
        log(p, `synth review failed, dropping ${chunk.length} unreviewed lines: ${(e as Error).message}`);
        return new Map<string, any>();
      })));
    for (const [ci, chunk] of chunks.entries()) {
      const byId = reviewed[ci]!;
      for (const it of chunk) {
        const v = byId.get(it.id);
        if (!v) continue;
        report.reviewed++;
        const scores = ["natural", "correct", "roman", "fit", "local"].map((k) => v[k]).filter((n) => typeof n === "number");
        const min = Math.min(...scores);
        if (v.verdict === "ok" && min >= 4) {
          report.ok++;
          accepted.push(it);
        } else if (v.verdict === "fix") {
          const f = parseItem(p, v.fixed, "sentence");
          const fixed: Item = { ...it, native: f.native, roman: f.roman };
          if (itemIssues(p, fixed).length || testIssues(p, fixed, tests).length) { report.droppedByReview++; continue; }
          report.fixed++;
          accepted.push(fixed);
        } else report.droppedByReview++;
      }
    }
    log(p, `synth round ${round}: ${fresh.length} passed checks, ${accepted.length}/${TARGET} accepted`);
  }

  if (p.roman) {
    const { changed } = await respell(p, b, accepted, `${p.code}-synth-spelling`, 250);
    report.spellingFixes = changed;
    // Respelling must not break a line; drop any that now fail.
    for (let i = accepted.length - 1; i >= 0; i--) if (itemIssues(p, accepted[i]!).length || testIssues(p, accepted[i]!, tests).length) accepted.splice(i, 1);
  }
  const items = accepted.slice(0, TARGET).map((x, i) => ({ id: `${p.code}-x${String(i + 1).padStart(4, "0")}`, kind: "sentence" as const, native: x.native, roman: x.roman }));
  writeFileSync(join(OUT_DIR, `${p.code}.synth.json`), JSON.stringify({ lang: p.code, items }, null, 1) + "\n");
  const words = items.flatMap((x) => (x.roman ?? x.native).join(" ").toLowerCase().split(/[^\p{L}\p{M}']+/u)).filter(Boolean);
  const summary = { lang: p.code, lines: items.length, vocabulary: { tokens: words.length, types: new Set(words).size }, ...report, wallMinutes: +((Date.now() - t0) / 60000).toFixed(1) };
  writeFileSync(join(STATE_DIR, `${p.code}.synth.summary.json`), JSON.stringify(summary, null, 1));
  log(p, `synth done: ${items.length} lines (${JSON.stringify(report)})`);
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--langs");
  const codes = args.includes("--all") ? PROFILES.map((p) => p.code)
    : args.includes("--pilot") ? ["en", "hi", "gu", "ar", "ja", "ta"]
    : i >= 0 ? args[i + 1]!.split(",").map((s) => s.trim()) : null;
  if (!codes) {
    console.error("usage: synth.ts --pilot | --all | --langs en,hi");
    process.exit(1);
  }
  const tests = new TestIndex(loadTestTexts());
  const queue = codes.map(profile);
  const failed: string[] = [];
  await Promise.all(Array.from({ length: Number(process.env.CORPUS_SYNTH_PARALLEL ?? 6) }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        await build(p, tests);
      } catch (e) {
        failed.push(p.code);
        console.error(`[${p.code}] SYNTH FAILED: ${(e as Error).message}`);
      }
    }
  }));
  console.log(JSON.stringify({ failed, llm: stats }, null, 1));
  if (failed.length) process.exit(2);
}

await main();
