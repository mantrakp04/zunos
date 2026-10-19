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

export type DataKind = "full" | "fresh" | "onboarding";

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

export function makeData(kind: DataKind): Data {
  const enabled = kind === "onboarding" ? [] : MY_LANGS;
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
  if (kind !== "full")
    return { ...common, prompts: prompts(0), clips: {}, runs: [], models: [], evals: {}, dictations: [] };

  const rs = runs();
  const models = [...modelFor(rs[0]!, false), ...modelFor(rs[1]!, true)];
  return {
    ...common,
    prompts: prompts(0.34),
    clips: {
      en: { trainSeconds: 1324, testSeconds: 402, trainClips: 141, testClips: 46 },
      hi: { trainSeconds: 918, testSeconds: 287, trainClips: 97, testClips: 31 },
      gu: { trainSeconds: 611, testSeconds: 196, trainClips: 66, testClips: 21 },
    },
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
