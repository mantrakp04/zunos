// Fake data for the browser preview harness. Shapes come from src/shared/types.ts (types only).
// Numbers are plausible, not real: WER is a fraction (0.071 = 7.1%), seconds are seconds.
import { LANGUAGES } from "@zunos/db/languages";

import type {
  Baseline,
  DictationItem,
  DictationSettings,
  CleanupSettings,
  EvalPoint,
  EvalResult,
  Lang,
  LangStats,
  Language,
  ModelItem,
  PromptItem,
  RunDetail,
  TrainingQuote,
  User,
} from "../shared/types";
import seed from "../../../../packages/db/src/seed-prompts.json";

export type DataKind = "full" | "fresh" | "onboarding" | "stress" | "partial" | "minimum";

export type Clips = Record<string, { trainSeconds: number; testSeconds: number; trainClips: number; testClips: number }>;

export type Data = {
  languages: Language[];
  prompts: PromptItem[];
  clips: Clips;
  runs: RunDetail[];
  models: ModelItem[];
  evals: Record<string, EvalResult>;
  baselines: Baseline[];
  dictations: DictationItem[];
  dictationSettings: DictationSettings;
  cleanupSettings: CleanupSettings;
  quote: TrainingQuote;
};

export const USER: User = { id: "u_preview", email: "owner@example.com", name: "Preview Owner" };
/** The account the stress data signs in as: a 40-character email. */
export const STRESS_USER: User = { id: "u_stress", email: "firstname.lastname.longer@zunos-team.dev", name: "Bartholomew Featherstonehaugh-Smythe" };
export const userFor = (kind: DataKind) => (kind === "stress" ? STRESS_USER : USER);

export const MY_LANGS: Lang[] = ["en", "hi", "gu"];
export const BASE = "openai/whisper-large-v3";

/** Small deterministic PRNG so curves look the same on every reload. */
export function rng(seedValue: number) {
  let s = seedValue >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const iso = (daysAgo: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
};

function languages(enabled: Lang[]): Language[] {
  const all = LANGUAGES.map((l, i) => ({
    code: l.code as Lang,
    name: l.name,
    script: l.romanized ? "Latin (romanized)" : "native",
    enabled: enabled.includes(l.code as Lang),
    sort: i,
  }));
  // Like library.languages(): the user's own first, then catalog order.
  all.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.sort - b.sort);
  return all.map(({ sort: _s, ...l }) => l);
}

type SeedPrompt = { id: string; lang: string; kind: string; title: string | null; lines: string[] };

function prompts(recordedShare: number): PromptItem[] {
  const r = rng(7);
  return (seed as SeedPrompt[]).map((p) => ({
    id: p.id,
    lang: p.lang as Lang,
    kind: p.kind as PromptItem["kind"],
    title: p.title,
    lines: p.lines,
    // Passages and twisters were recorded first; sentences are about a third done.
    recorded: recordedShare > 0 && (p.kind !== "sentence" ? r() < 0.85 : r() < recordedShare),
  }));
}

function evalCurve(steps: number, every: number, start: Record<string, number>, end: Record<string, number>, seedValue: number): EvalPoint[] {
  const r = rng(seedValue);
  const out: EvalPoint[] = [];
  for (let step = 0; step <= steps; step += every) {
    const t = step / steps;
    // Fast early drop, then a slow tail with a little noise.
    const k = 1 - Math.exp(-4.2 * t);
    const langs: Record<string, number> = {};
    for (const l of Object.keys(start)) langs[l] = +(start[l]! + (end[l]! - start[l]!) * k + (r() - 0.5) * 0.012).toFixed(4);
    const vals = Object.values(langs);
    out.push({ step, score: +(vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(4), langs });
  }
  return out;
}

function lossCurve(steps: number, every: number, from: number, to: number, seedValue: number) {
  const r = rng(seedValue);
  const out: { step: number; loss: number | null }[] = [];
  for (let step = every; step <= steps; step += every) {
    const t = step / steps;
    out.push({ step, loss: +(to + (from - to) * Math.exp(-5 * t) + (r() - 0.5) * 0.05).toFixed(4) });
  }
  return out;
}

const CFG = { base: BASE, lr: 1e-5, epochs: 3, bs: 16, accum: 2, eval_every: 100, freeze_enc: 0 };

function best(evals: EvalPoint[]) {
  return evals.reduce((b, e) => (e.score < b.score ? e : b), evals[0]!);
}

function runs(): RunDetail[] {
  const e1 = evalCurve(1200, 100, { en: 0.21, hi: 0.86, gu: 1.42 }, { en: 0.094, hi: 0.205, gu: 0.262 }, 11);
  const e2 = evalCurve(1600, 100, { en: 0.1, hi: 0.22, gu: 0.28 }, { en: 0.068, hi: 0.139, gu: 0.171 }, 12);
  const e3 = evalCurve(400, 100, { en: 0.07, hi: 0.14, gu: 0.18 }, { en: 0.069, hi: 0.15, gu: 0.19 }, 13);
  const b1 = best(e1), b2 = best(e2);
  return [
    {
      id: "r1", name: "v1", base: BASE, status: "done", stage: "downloaded", bestStep: b1.step, bestScore: b1.score, costUsd: 1.18,
      createdAt: iso(12, 9), cfg: CFG, steps: lossCurve(1200, 20, 1.9, 0.32, 21), evals: e1,
    },
    {
      id: "r2", name: "v2", base: "r1", status: "done", stage: "downloaded", bestStep: b2.step, bestScore: b2.score, costUsd: 1.46,
      createdAt: iso(5, 14), cfg: { ...CFG, base: "r1", epochs: 4 }, steps: lossCurve(1600, 20, 0.9, 0.21, 22), evals: e2,
    },
    {
      id: "r3", name: "v3", base: "r2", status: "failed", stage: "train", bestStep: null, bestScore: null, costUsd: 0.41,
      createdAt: iso(2, 20), cfg: { ...CFG, base: "r2", lr: 2e-5 }, steps: lossCurve(400, 20, 0.7, 0.4, 23), evals: e3,
    },
  ];
}

/** A run on the cloud GPU right now, at the given remote stage. */
export function inflightRun(stage: string, n: number): RunDetail {
  const training = ["train", "export", "upload"].includes(stage);
  const evals = training ? evalCurve(stage === "train" ? 600 : 1600, 100, { en: 0.07, hi: 0.15, gu: 0.18 }, { en: 0.058, hi: 0.118, gu: 0.142 }, 14) : [];
  const b = evals.length ? best(evals) : null;
  return {
    id: `r${n}`, name: `v${n}`, base: "r2", status: "running", stage, bestStep: b?.step ?? null, bestScore: b?.score ?? null,
    costUsd: training ? 0.86 : stage === "starting" ? null : 0.12, createdAt: new Date().toISOString(),
    cfg: { ...CFG, base: "r2" }, steps: training ? lossCurve(stage === "train" ? 640 : 1600, 20, 0.8, 0.18, 24) : [], evals,
  };
}

export function modelFor(run: RunDetail, active: boolean): ModelItem[] {
  const score = { step: run.bestStep, score: run.bestScore, cfg: { base: run.cfg.base ?? BASE } };
  return [
    { id: `m-${run.id}-hf`, name: run.name, format: "hf", active, runId: run.id, score },
    { id: `m-${run.id}-mlx`, name: run.name, format: "mlx", active, runId: run.id, score },
  ];
}

const HYP_SLIPS: [RegExp, string][] = [
  [/\bthe\b/i, "a"], [/\bhai\b/, "he"], [/\bchhe\b/, "che"], [/\bkal\b/, "call"], [/\bminutes\b/, "minute"], [/,/, ""],
];

export function evalFor(modelId: string, scores: Record<string, number>, seedValue: number): EvalResult {
  const r = rng(seedValue);
  const pool = (seed as SeedPrompt[]).filter((p) => p.kind === "sentence");
  const rows: EvalResult["rows"] = [];
  const per: Record<string, number> = { en: 8, hi: 6, gu: 6 };
  for (const lang of MY_LANGS) {
    const mine = pool.filter((p) => p.lang === lang);
    for (let i = 0; i < per[lang]!; i++) {
      const ref = mine[(i * 17 + seedValue) % mine.length]!.lines[0]!;
      let hyp = ref;
      let wer = 0;
      if (r() < 0.55) {
        const [re, to] = HYP_SLIPS[Math.floor(r() * HYP_SLIPS.length)]!;
        hyp = ref.replace(re, to);
        if (hyp !== ref) wer = +(1 / ref.split(" ").length).toFixed(3);
      }
      if (r() < 0.15) {
        const words = hyp.split(" ");
        words.splice(Math.floor(r() * words.length), 1);
        hyp = words.join(" ");
        wer = +(wer + 1 / ref.split(" ").length).toFixed(3);
      }
      rows.push({ id: `clip-${lang}-${i + 1}`, lang, ref, hyp, wer });
    }
  }
  const vals = MY_LANGS.map((l) => scores[l]!);
  return { modelId, beams: 4, scores: { ...scores, avg: +(vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(4) }, rows, createdAt: iso(4, 16) };
}

function dictations(): DictationItem[] {
  const base = { style: "light" as const, status: "ok" as const, error: null, hasAudio: true, corrected: null, clip: null };
  return [
    { ...base, id: "d6", createdAt: iso(0, 11), seconds: 6.2, lang: "en", appName: "Slack", raw: "um can you push the build to staging before lunch", clean: "Can you push the build to staging before lunch?" },
    { ...base, id: "d5", createdAt: iso(0, 10), seconds: 4.8, lang: "hi", appName: "Messages", raw: "main das minute mein pahunch raha hoon traffic bahut hai", clean: "Main das minute mein pahunch raha hoon, traffic bahut hai." },
    { ...base, id: "d4", createdAt: iso(1, 18), seconds: 9.1, lang: "gu", appName: "WhatsApp", raw: "kale savare aapne office ma malie pachhi nakki kariye", clean: "Kale savare aapne office ma malie, pachhi nakki kariye.", corrected: "kale savare aapne office ma maliye pachhi nakki kariye" },
    { ...base, id: "d3", createdAt: iso(1, 15), seconds: 12.4, lang: "en", appName: "Notes", raw: "remind me to send the invoice no wait the quote to priya on friday", clean: "Remind me to send the quote to Priya on Friday.", style: "polished", clip: { id: "c-991", split: "train" } },
    { ...base, id: "d2", createdAt: iso(2, 9), seconds: 3.1, lang: null, appName: null, raw: "", clean: null, style: null, status: "failed", error: "The engine stopped while transcribing." },
    { ...base, id: "d1", createdAt: iso(3, 21), seconds: 5.5, lang: "en", appName: "Mail", raw: "thanks for the quick turnaround looks great", clean: null, style: null },
  ];
}

const QUOTE: TrainingQuote = { gpu: "NVIDIA A40", pricePerHour: 0.44, estimatedHours: 2.6, available: true };


/* ---- stress: everything as long, many and odd as it gets, to find overflows ------------------ */

/** 22 languages, long names first, so every strip, chip row and legend has to cope. */
export const STRESS_LANGS: Lang[] = [
  "ht", "lb", "en", "hi", "gu", "az", "id", "uk", "ar", "zh", "ja", "pt", "ml", "kn", "be", "mk", "sw", "vi", "he", "fa", "ta", "mr",
] as Lang[];

const LONG_PASSAGE = [
  "When the monsoon finally arrived after weeks of heavy, unmoving heat, the whole neighbourhood stepped out onto their balconies to watch the first fat drops darken the dusty street below.",
  "Somebody's radio was playing an old film song, and the woman who runs the corner shop started humming along while she pulled the tarpaulin over her crates of mangoes and onions.",
  "https://docs.example.com/projects/voice-data/very/long/path/that/never/breaks/because/it/has/no/spaces/at-all?query=supercalifragilisticexpialidocious&and=more",
  "Antidisestablishmentarianism, pneumonoultramicroscopicsilicovolcanoconiosis and floccinaucinihilipilification are words people only say to prove they can.",
];
const SENTENCE_25 =
  "Before we leave for the airport tomorrow morning, could you please double-check that the passports, the chargers and the printed tickets are all in the blue bag?";
const ARABIC = "يرجى إرسال التقرير النهائي إلى فريق التصميم قبل نهاية يوم الخميس حتى نتمكن من مراجعته معًا.";
const CJK = "明天早上九点我们在会议室见面，请把最新的设计稿和用户访谈记录一起带过来，我们需要在中午之前确定最终方案。";

function stressPrompts(): PromptItem[] {
  const out: PromptItem[] = [];
  STRESS_LANGS.forEach((lang, i) => {
    out.push(
      { id: `s-${lang}-p`, lang, kind: "para", title: "A remarkably long passage title that keeps going well past where any title should stop", lines: LONG_PASSAGE, recorded: false },
      { id: `s-${lang}-s`, lang, kind: "sentence", title: null, lines: [SENTENCE_25], recorded: i % 3 === 0 },
      { id: `s-${lang}-ar`, lang, kind: "sentence", title: null, lines: [ARABIC], recorded: false },
      { id: `s-${lang}-zh`, lang, kind: "para", title: "中文段落", lines: [CJK, CJK], recorded: false },
      { id: `s-${lang}-t`, lang, kind: "twister", title: "Twister", lines: ["Pneumonoultramicroscopicsilicovolcanoconiosis"], recorded: false },
    );
  });
  return [...out, ...prompts(0.5)];
}

function stressRuns(): RunDetail[] {
  const start = Object.fromEntries(STRESS_LANGS.map((l, i) => [l, 0.3 + (i % 5) * 0.18]));
  const end = Object.fromEntries(STRESS_LANGS.map((l, i) => [l, i === 0 ? 0 : i === 1 ? 1 : 0.04 + (i % 7) * 0.03]));
  const out: RunDetail[] = [];
  for (let n = 1; n <= 99; n++) {
    const evals = n > 90 || n % 9 === 0 ? evalCurve(2400, 100, start, end, 100 + n) : [];
    const b = evals.length ? best(evals) : null;
    const status = n === 99 ? "failed" : n % 13 === 0 ? "cancelled" : "done";
    out.push({
      id: `r${n}`,
      name: n === 98 ? "v98-accurate-long-context-with-extra-cloned-voices-final-final" : `v${n}`,
      base: n === 1 ? BASE : `r${n - 1}`,
      status,
      stage: status === "done" ? "downloaded" : "train",
      bestStep: b?.step ?? null,
      bestScore: b?.score ?? null,
      costUsd: n === 98 ? 1234.56 : n === 97 ? 0 : +(0.4 + (n % 11) * 0.37).toFixed(2),
      createdAt: iso(120 - n, 9 + (n % 12)),
      cfg: { ...CFG, base: n === 1 ? BASE : `r${n - 1}` },
      steps: evals.length ? lossCurve(2400, 20, 2.4, 0.11, 200 + n) : [],
      evals,
    });
  }
  return out;
}

function stressEval(modelId: string): EvalResult {
  const scores: Record<string, number> = Object.fromEntries(STRESS_LANGS.map((l, i) => [l, i === 0 ? 0 : i === 1 ? 1 : +(0.03 + (i % 9) * 0.041).toFixed(4)]));
  const rows: EvalResult["rows"] = [];
  STRESS_LANGS.forEach((lang, i) => {
    rows.push(
      { id: `sc-${lang}-1`, lang, ref: SENTENCE_25, hyp: SENTENCE_25.replace("passports", "passwords").replace("blue", "glue"), wer: 0.08 },
      { id: `sc-${lang}-2`, lang, ref: LONG_PASSAGE[2]!, hyp: LONG_PASSAGE[2]!.replace("docs", "dogs"), wer: 1 },
      { id: `sc-${lang}-3`, lang, ref: i % 2 ? ARABIC : CJK, hyp: i % 2 ? ARABIC.slice(0, 40) : CJK.slice(5), wer: 0.37 },
    );
  });
  const vals = Object.values(scores);
  return { modelId, beams: 4, scores: { ...scores, avg: +(vals.reduce((x, y) => x + y, 0) / vals.length).toFixed(4) }, rows, createdAt: iso(1, 16) };
}

function stressDictations(): DictationItem[] {
  const texts = [
    { raw: LONG_PASSAGE[2]!, clean: LONG_PASSAGE[2]! },
    { raw: ARABIC, clean: ARABIC },
    { raw: CJK, clean: CJK },
    { raw: `um so ${LONG_PASSAGE[0]!.toLowerCase()} ${LONG_PASSAGE[1]!.toLowerCase()}`, clean: `${LONG_PASSAGE[0]} ${LONG_PASSAGE[1]}` },
    { raw: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", clean: null },
    { raw: "ok", clean: "OK." },
  ];
  const apps = ["Microsoft Outlook for Mac (Insider Fast Ring Preview Edition)", "Slack", null, "Messages"];
  const out: DictationItem[] = [];
  for (let i = 0; i < 200; i++) {
    const t = texts[i % texts.length]!;
    const failed = i % 17 === 5;
    out.push({
      id: `sd${i}`,
      createdAt: iso(Math.floor(i / 6), 23 - (i % 12)),
      seconds: i === 3 ? 1234.5 : +(1 + (i % 29) * 1.3).toFixed(1),
      lang: failed ? null : STRESS_LANGS[i % STRESS_LANGS.length]!,
      raw: failed ? "" : t.raw,
      clean: failed ? null : t.clean,
      style: failed || !t.clean ? null : i % 2 ? "light" : "polished",
      corrected: i % 11 === 4 ? `${t.raw} with an extra correction typed by hand` : null,
      appName: apps[i % apps.length]!,
      status: failed ? "failed" : "ok",
      error: failed ? "The engine exited (code 1) while transcribing: MPS backend out of memory (MPS allocated: 17.95 GB, other allocations: 2.11 GB, max allowed: 20.13 GB)." : null,
      clip: i % 7 === 2 ? { id: `c-${i}`, split: i % 2 ? "train" : "test" } : null,
      hasAudio: i % 34 !== 5,
    });
  }
  return out;
}

function stressData(common: Omit<Data, "prompts" | "clips" | "runs" | "models" | "evals" | "dictations">): Data {
  const rs = stressRuns();
  const longName = rs.find((r) => r.id === "r98")!;
  const lastGood = rs.filter((r) => r.evals.length && r.status === "done" && r !== longName).at(-1)!;
  const models = [...modelFor(rs[0]!, false), ...modelFor(longName, true), ...modelFor(lastGood, false)];
  const clips: Clips = {};
  STRESS_LANGS.forEach((l, i) => {
    // English carries the 1234.5-minute total; one language has nothing yet.
    const total = i === 2 ? 74070 * 0.75 : i === 5 ? 0 : 60 + i * 97;
    clips[l] = { trainSeconds: total * 0.76, testSeconds: total * 0.24, trainClips: Math.round(total / 9), testClips: Math.round(total / 30) };
  });
  return {
    ...common,
    languages: common.languages.map((l) => (l.code === "ht" ? { ...l, name: "Kreyòl ayisyen (Haitian Creole)" } : l.code === "lb" ? { ...l, name: "Lëtzebuergesch (Luxembourgish)" } : l)),
    baselines: STRESS_LANGS.filter((_, i) => i % 4 !== 3).map((lang, i) => ({ provider: "reference" as const, lang, wer: i === 0 ? 1 : +(0.05 + (i % 6) * 0.07).toFixed(3) })),
    quote: { gpu: "NVIDIA H100 80GB HBM3 (SXM5, 8× NVLink)", pricePerHour: 12.5, estimatedHours: 98.76, available: true },
    prompts: stressPrompts(),
    clips,
    runs: rs,
    models,
    evals: Object.fromEntries(models.filter((m) => m.format === "hf").map((m) => [m.id, stressEval(m.id)])),
    dictations: stressDictations(),
  };
}

export function makeData(kind: DataKind): Data {
  const enabled = kind === "onboarding" ? [] : kind === "stress" ? STRESS_LANGS : MY_LANGS;
  const common = {
    languages: languages(enabled),
    // The reference recognizer; the UI labels it "Reference" and never names a vendor.
    baselines: [
      { provider: "reference", lang: "en", wer: 0.121 },
      { provider: "reference", lang: "hi", wer: 0.304 },
      { provider: "reference", lang: "gu", wer: 0.377 },
    ] satisfies Baseline[],
    dictationSettings: { hotkey: "rightOption", mode: "hybrid", paste: true, restoreClipboard: true } as DictationSettings,
    cleanupSettings: { style: "light" } as CleanupSettings,
    quote: QUOTE,
  };
  if (kind === "stress") return stressData(common);
  if (kind === "fresh" || kind === "onboarding")
    return { ...common, prompts: prompts(0), clips: {}, runs: [], models: [], evals: {}, dictations: [] };

  const rs = runs();
  const models = [...modelFor(rs[0]!, false), ...modelFor(rs[1]!, true)];
  // Minutes per language: a full set everywhere, or (partial) one language under the 5-minute
  // minimum, or (minimum) everything between the minimum and a full set.
  const mins: Record<string, number> =
    kind === "partial" ? { en: 6, hi: 6.2, gu: 3 } : kind === "minimum" ? { en: 6.5, hi: 8, gu: 5.4 } : { en: 28.8, hi: 20.1, gu: 13.4 };
  const clip = (m: number) => ({ trainSeconds: m * 60 * 0.77, testSeconds: m * 60 * 0.23, trainClips: Math.round(m * 4.9), testClips: Math.round(m * 1.6) });
  return {
    ...common,
    prompts: prompts(0.34),
    clips: { en: clip(mins.en!), hi: clip(mins.hi!), gu: clip(mins.gu!) },
    runs: rs,
    models,
    evals: {
      "m-r1-hf": evalFor("m-r1-hf", { en: 0.096, hi: 0.211, gu: 0.268 }, 31),
      "m-r2-hf": evalFor("m-r2-hf", { en: 0.071, hi: 0.142, gu: 0.168 }, 32),
    },
    dictations: dictations(),
  };
}

export function statsOf(d: Data): LangStats[] {
  return d.languages
    .filter((l) => l.enabled)
    .map(({ code }) => {
      const c = d.clips[code] ?? { trainSeconds: 0, testSeconds: 0, trainClips: 0, testClips: 0 };
      const ps = d.prompts.filter((p) => p.lang === code);
      return { lang: code, ...c, promptsRecorded: ps.filter((p) => p.recorded).length, promptsTotal: ps.length };
    });
}

/** Things the fake recognizer "hears" when you dictate. */
export const HEARD: { lang: Lang; raw: string; clean: string }[] = [
  { lang: "en", raw: "so i think we should um move the demo to thursday", clean: "So I think we should move the demo to Thursday." },
  { lang: "hi", raw: "aaj shaam ko milte hain coffee pe", clean: "Aaj shaam ko milte hain, coffee pe." },
  { lang: "gu", raw: "hu tane pachhi phone karu chhu", clean: "Hu tane pachhi phone karu chhu." },
  { lang: "en", raw: "add milk eggs and uh the good bread to the list", clean: "Add milk, eggs, and the good bread to the list." },
];
