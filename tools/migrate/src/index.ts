// One-shot import of the pre-app data (data/, corpus/, recorder/, pod-backup/, dashboard/, synth_fish/)
// into the zunos app database. Audio is copied (never moved) and every copy is checked by sha256.
//
//   bun tools/migrate/src/index.ts [--src <repo>] [--dest <app data dir>] [--move-models]
//
// Safe to re-run: rows are upserted and files that already match are skipped.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { DB_FILE, schema } from "@zunos/db";
import { openBunDb } from "@zunos/db/bun";
import { sql } from "drizzle-orm";

import { FINAL } from "./legacy-finalize";

const { values: args } = parseArgs({
  options: {
    src: { type: "string", default: join(import.meta.dir, "../../..") },
    dest: { type: "string", default: join(homedir(), "Library/Application Support/zunos") },
    "move-models": { type: "boolean", default: false },
  },
});
const SRC = args.src!;
const DEST = args.dest!;

// The 13 held-back clips (python/core/src/zunos_core/testset.py).
const LEGACY_TEST = new Set([
  "para-en-02", "para-en-05", "para-en-07", "twister-05-en-31",
  "para-hi-11", "para-hi-12", "para-hi-13", "para-hi-15", "twister-08-hi-34",
  "para-gu-19", "para-gu-22", "para-gu-23", "para-gu-24",
]);
// Native-script text of the clips used as voice-cloning references (python/pod/make_jobs.py NATIVE_REF).
const NATIVE_TEXT: Record<string, string> = {
  "para-hi-08": "हर सुबह साढ़े छह बजे रमेश अपनी पुरानी साइकिल उठाता है और सब्ज़ी मंडी की तरफ़ निकल पड़ता है। रास्ते में चाय वाला भैया हमेशा आवाज़ लगाता है, और रमेश",
  "para-gu-16": "રોજ સવારે સાત વાગે કવિતા બેન પોતાના ઘરે, પોતાના ઘરની બારી ખોલીને આંગણામાં તુલસીને પાણી આપે છે. પછી તે રસોડામાં જાય છે અને",
  "para-gu-17": "આખા પરિવાર માટે ગરમ ગરમ ચા અને થેપલા બનાવે છે. તેમનો દીકરો જય હજી પણ ઊંઘતો હોય છે, અને તેને ઉઠાડવા માટે",
  "para-gu-20": "બપોરે કવિતા બેન બજાર જાય છે, જ્યાં શાકભાજી વાળો કાકા તેમને જોઈને કહે છે, આવો બેન,",
};
const SARVAM_COST_NOTE = "Sarvam saaras fuzzy WER on the same 13 test clips and answer key";
const CLOUD_COST_USD = 6.49; // total Runpod spend for the first runs (dashboard/final.json)

const src = (...p: string[]) => join(SRC, ...p);
const readJson = (p: string) => JSON.parse(readFileSync(src(p), "utf8"));
const readJsonl = (p: string) =>
  readFileSync(src(p), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// ---------------------------------------------------------------- files

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const copied: { from: string; to: string }[] = [];
const missing: string[] = [];

/** Copy a source file into the app folder and return its path relative to DEST (null if absent). */
function copy(from: string, rel: string): string | null {
  if (!existsSync(from)) {
    missing.push(from);
    return null;
  }
  const to = join(DEST, rel);
  if (!existsSync(to) || statSync(to).size !== statSync(from).size) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  copied.push({ from, to });
  return rel;
}

// ---------------------------------------------------------------- db

mkdirSync(DEST, { recursive: true });
const { sqlite, db } = await openBunDb(join(DEST, DB_FILE));
const upsert = <T extends Parameters<typeof db.insert>[0]>(table: T, rows: any[], target: any) => {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const set = Object.fromEntries(Object.keys(chunk[0]).map((k) => [k, sql.raw(`excluded.${(table as any)[k].name}`)]));
    db.insert(table).values(chunk).onConflictDoUpdate({ target, set }).run();
  }
};
const count: Record<string, number> = {};

sqlite.exec("BEGIN");

// Languages: all three are enabled for the owner's existing data.
upsert(schema.languages, [
  { code: "en", name: "English", script: "Latin", enabled: true, sort: 0 },
  { code: "hi", name: "Hindi", script: "Latin (romanized)", enabled: true, sort: 1 },
  { code: "gu", name: "Gujarati", script: "Latin (romanized)", enabled: true, sort: 2 },
], schema.languages.code);

// ---------------------------------------------------------------- session 1: recordings, segments, clips

const manifest: Record<string, any> = readJson("data/manifest.json");
const promptRows = [];
const recordingRows = [];
for (const [id, m] of Object.entries(manifest)) {
  promptRows.push({ id, lang: m.lang, kind: m.kind, title: null, lines: m.lines, nativeLines: null, source: "session-1" });
  recordingRows.push({
    id, promptId: id, lang: m.lang, kind: m.kind,
    path: copy(src("data", m.file), `audio/recordings/${id}.wav`)!,
    sampleRate: m.sampleRate, seconds: m.seconds, marks: m.marks, recordedAt: m.recordedAt,
  });
}

// Prompts read in later sessions (recorder/prompts.ts) and the dictation corpus.
const { prompts: recorderPrompts } = await import(src("recorder/prompts.ts"));
for (const p of recorderPrompts)
  promptRows.push({ id: p.id, lang: p.lang, kind: p.kind, title: p.title, lines: p.lines, nativeLines: null, source: "recorder" });

// Corpus ids follow python/pod/make_jobs.py: one list per language (file 1 then file 2), 0-based.
const corpusIndex: Record<string, string[]> = {};
for (const lang of ["en", "hi", "gu"] as const) {
  const files = lang === "en" ? ["en1.txt", "en2.txt"] : [`${lang}1.tsv`, `${lang}2.tsv`];
  const lines = files.flatMap((f) => readFileSync(src("corpus", f), "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
  corpusIndex[lang] = [];
  lines.forEach((l, i) => {
    const [roman, native] = lang === "en" ? [l, null] : l.split("\t").map((s) => s.trim());
    const id = `corpus-${lang}-${String(i).padStart(3, "0")}`;
    corpusIndex[lang]!.push(id);
    promptRows.push({ id, lang, kind: "sentence", title: null, lines: [roman], nativeLines: native ? [native] : null, source: "corpus" });
  });
}
upsert(schema.prompts, promptRows, schema.prompts.id);
upsert(schema.recordings, recordingRows, schema.recordings.id);
count.prompts = promptRows.length;
count.recordings = recordingRows.length;

const segs: any[] = readJson("data/segments.json");
const segById = Object.fromEntries(segs.map((s) => [s.id, s]));
upsert(schema.segments, segs.map((s) => ({
  id: s.id, recordingId: s.source, start: s.start, end: s.end,
  path: copy(src("data/segments", `${s.id}.wav`), `audio/segments/${s.id}.wav`),
})), schema.segments.id);
count.segments = segs.length;

// Sarvam transcripts: replace any earlier import so re-runs don't duplicate.
sqlite.exec("DELETE FROM transcriptions WHERE provider LIKE 'sarvam-%'");
const transcriptionRows = [
  ...readJson("data/sarvam.json").map((s: any) => ({ segmentId: s.id, provider: "sarvam-saaras-v3", verbatim: s.verbatim, roman: s.roman })),
  ...readJson("data/sarvam-v4.json").map((s: any) => ({ segmentId: s.id, provider: "sarvam-saaras-v4", verbatim: s.verbatim, roman: s.roman })),
];
for (let i = 0; i < transcriptionRows.length; i += 200) db.insert(schema.transcriptions).values(transcriptionRows.slice(i, i + 200)).run();
count.transcriptions = transcriptionRows.length;

const transcripts = Object.fromEntries(readJsonl("data/final/transcripts.jsonl").map((r) => [r.id, r]));
const podSplit = Object.fromEntries(readJsonl("pod-backup/real.jsonl").map((r) => [r.id, r.split]));
const clipRows = FINAL.map(([parts, text, unsure], i) => {
  const first = segById[parts[0]!], last = segById[parts.at(-1)!];
  const id = `${first.source}-${String(i).padStart(2, "0")}`;
  const t = transcripts[id];
  if (!t || t.text !== text) throw new Error(`finalize table and transcripts.jsonl disagree on ${id}`);
  const split = LEGACY_TEST.has(id) ? "test" : "train";
  if (podSplit[id] !== split) throw new Error(`split of ${id} differs from pod-backup/real.jsonl`);
  return {
    id, recordingId: first.source, lang: t.lang, kind: t.kind, start: first.start, end: last.end, seconds: t.seconds,
    path16k: copy(src("data/final/16k", `${id}.wav`), `audio/clips/16k/${id}.wav`)!,
    path48k: copy(src("data/final/48k", `${id}.wav`), `audio/clips/48k/${id}.wav`),
    text, nativeText: NATIVE_TEXT[id] ?? null, unsure: !!unsure, split, segmentIds: parts,
  };
});
upsert(schema.clips, clipRows, schema.clips.id);
count.clips = clipRows.length;
count.testClips = clipRows.filter((c) => c.split === "test").length;

// ---------------------------------------------------------------- runs, evals, models

const final = readJson("dashboard/final.json");
const runRows = [];
const stepRows = [];
const evalRows = [];
for (const r of final.runs.filter((r: any) => r.cfg)) {
  const score = readJson(`pod-backup/ckpt-logs/${r.name}/score.json`);
  const logRel = copy(src("pod-backup/logs", `train_${r.name}.log`), `runs/${r.name}/train.log`);
  runRows.push({
    // dashboard/final.json stores cfg as a Python repr string; score.json has the real object.
    id: r.name, name: r.name, base: String(score.cfg.base).replace("/workspace/ckpt/", "").replace("/best", ""), cfg: score.cfg,
    status: "done", stage: "done", gpu: null, costUsd: null, remoteId: null,
    bestStep: score.step, bestScore: score.score, logPath: logRel,
    notes: r.name === "v3a" ? "Current model (models/final-hf)." : null, startedAt: null, finishedAt: null,
  });
  for (const s of r.train) stepRows.push({ runId: r.name, step: s.step, epoch: s.ep ?? null, loss: s.loss, lr: s.lr });
  for (const e of readJsonl(`pod-backup/ckpt-logs/${r.name}/log.jsonl`))
    evalRows.push({ runId: r.name, modelId: null, step: e.step, beams: 1, score: e.score, scores: e.res, rows: e.rows });
}
upsert(schema.runs, runRows, schema.runs.id);
upsert(schema.runSteps, stepRows, [schema.runSteps.runId, schema.runSteps.step]);
sqlite.exec("DELETE FROM evals WHERE run_id IN ('quick','r1','v3a','v3b') AND model_id IS NULL");
for (let i = 0; i < evalRows.length; i += 100) db.insert(schema.evals).values(evalRows.slice(i, i + 100)).run();
count.runs = runRows.length;
count.evals = evalRows.length;

// Remaining pod logs (generation, filter, setup) are kept with the runs for reference.
for (const f of readdirSync(src("pod-backup/logs")).filter((f) => !f.startsWith("train_")))
  copy(src("pod-backup/logs", f), `runs/_pod-logs/${f}`);

const sarvam = readJson("dashboard/sarvam.json");
upsert(schema.baselines, Object.entries(sarvam).map(([lang, wer]) => ({ provider: "sarvam-saaras", lang, wer })),
  [schema.baselines.provider, schema.baselines.lang]);

// ---------------------------------------------------------------- synthetic clips

const scored = Object.fromEntries(readJsonl("pod-backup/synth_scored.jsonl").map((r) => [r.id, r]));
const fishJobs = Object.fromEntries(readJsonl("pod-backup/fish_jobs.jsonl").map((r) => [r.id, r]));
const clipIds = new Set(clipRows.map((c) => c.id));
const synthRows = readJsonl("pod-backup/jobs.jsonl").map((j) => {
  const fish = fishJobs[j.id];
  const s = scored[j.id] ?? {};
  const { id, engine, lang, target, gen_text, ref, ref_text, style, plain_text, ...params } = fish ?? j;
  const refId = basename(ref, ".wav");
  const refDir = fish ? "refs_fish" : "refs";
  const rawFrom = fish ? src("synth_fish", `${id}.wav`) : src("dashboard/samples", `${id}.wav`);
  const index = Number(id.split("-")[1]);
  return {
    id, lang, engine, promptId: corpusIndex[lang]?.[index] ?? null, target, genText: gen_text, style: style ?? null,
    refClipId: clipIds.has(refId) ? refId : null,
    refPath: copy(src("pod-backup", refDir, `${refId}.wav`), `audio/refs/${refDir === "refs" ? "24k" : "44k"}/${refId}.wav`),
    refText: ref_text || null, params: plain_text ? { ...params, plain_text } : params,
    dur: s.dur ?? null, score: s.score ?? null, scoreNative: s.score_native ?? null, cps: s.cps ?? null, hyp: s.hyp ?? null,
    path16k: copy(src("pod-backup/synth16", `${id}.wav`), `audio/synth/16k/${id}.wav`),
    pathRaw: existsSync(rawFrom) ? copy(rawFrom, `audio/synth/raw/${id}.wav`) : null,
    runId: null,
  };
});
upsert(schema.synthClips, synthRows, schema.synthClips.id);
count.synthClips = synthRows.length;
// The dashboard also copied 24 kHz takes of some Fish clips whose raw file is the 44.1 kHz original; keep them too.
for (const f of readdirSync(src("dashboard/samples")).filter((f) => fishJobs[basename(f, ".wav")]))
  copy(src("dashboard/samples", f), `audio/synth/raw-24k/${f}`);
count.synthRaw = synthRows.filter((r) => r.pathRaw).length;

// ---------------------------------------------------------------- models

const modelRows = [];
for (const [name, format, from] of [["v3a-hf", "hf", "models/final-hf"], ["v3a-mlx", "mlx", "models/final-mlx"]] as const) {
  const rel = `models/${name}`;
  const to = join(DEST, rel);
  let path = src(from);
  if (args["move-models"] && existsSync(src(from)) && !existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(src(from), to); // same volume: a rename, not a copy
  }
  if (existsSync(to)) path = rel;
  const scoreFile = join(existsSync(to) ? to : src(from), "score.json");
  modelRows.push({
    id: name, runId: "v3a", name: format === "hf" ? "v3a (accurate)" : "v3a (fast)", format, path,
    score: existsSync(scoreFile) ? JSON.parse(readFileSync(scoreFile, "utf8")) : null, active: format === "hf",
  });
}
upsert(schema.models, modelRows, schema.models.id);

upsert(schema.settings, [
  { key: "legacy_import", value: { at: new Date().toISOString(), src: SRC } },
  { key: "legacy_cloud_cost_usd", value: CLOUD_COST_USD },
  { key: "baseline_note", value: SARVAM_COST_NOTE },
], schema.settings.key);

sqlite.exec("COMMIT");

// ---------------------------------------------------------------- verify

let bad = 0;
for (const { from, to } of copied) if (sha(from) !== sha(to)) { bad++; console.error(`checksum mismatch: ${to}`); }
const db_ = (q: string) => (sqlite.query(q).get() as { n: number }).n;
const expect: [string, number, number][] = [
  ["clips", db_("SELECT count(*) n FROM clips"), 36],
  ["test clips", db_("SELECT count(*) n FROM clips WHERE split='test'"), 13],
  ["corpus sentences", db_("SELECT count(*) n FROM prompts WHERE source='corpus'"), 721],
  ["synthetic clips", db_("SELECT count(*) n FROM synth_clips"), 4743],
  ["synthetic clips with audio", db_("SELECT count(*) n FROM synth_clips WHERE path_16k IS NOT NULL"), 4743],
  ["runs", db_("SELECT count(*) n FROM runs"), 4],
];
console.log(`\nimported into ${DEST}`);
console.log(Object.entries(count).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
console.log(`  files copied and verified: ${copied.length - bad}/${copied.length}`);
if (missing.length) console.log(`  source files not found (${missing.length}):\n    ${missing.slice(0, 10).join("\n    ")}`);
let ok = bad === 0;
for (const [what, got, want] of expect) {
  const pass = got === want;
  ok &&= pass;
  console.log(`  ${pass ? "✓" : "✗"} ${what}: ${got}${pass ? "" : ` (expected ${want})`}`);
}
console.log(ok ? "\nverify: OK" : "\nverify: FAILED");
process.exit(ok ? 0 : 1);
