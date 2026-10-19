import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "/Users/barreloflube/voice-data/data";
const OUT = `${DIR}/segments`;
mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8"));
const MAX = 18;
const MIN = 3;

function silences(file: string) {
  const r = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", file, "-af", "asetnsamples=2400,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"]);
  const frames = [...r.stderr.toString().matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -120 : Number(m[1])));
  const sorted = [...frames].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.25)]! + 2;
  const step = 0.05;
  const out: { s: number; e: number; mid: number }[] = [];
  let run = -1;
  frames.forEach((db, i) => {
    if (db < threshold) { if (run < 0) run = i; return; }
    if (run >= 0 && i - run >= 5) out.push({ s: run * step, e: i * step, mid: ((run + i) / 2) * step });
    run = -1;
  });
  return out;
}

const rows: { id: string; source: string; lang: string; kind: string; start: number; end: number; file: string }[] = [];
for (const [id, m] of Object.entries<any>(manifest)) {
  const src = `${DIR}/${m.file}`;
  const total = m.seconds;
  const cuts: number[] = [];
  if (m.kind === "para") {
    let last = 0;
    const gaps = silences(src);
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i]!;
      const next = gaps[i + 1];
      const len = g.mid - last;
      if (len < MIN) continue;
      if (len >= MAX * 0.6 || !next || next.mid - last > MAX) { cuts.push(g.mid); last = g.mid; }
    }
  }
  const bounds = [0, ...cuts, total];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!, end = bounds[i + 1]!;
    if (end - start < 0.8) continue;
    const seg = `${id}-${String(i).padStart(2, "0")}`;
    const file = `${OUT}/${seg}.wav`;
    Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ss", String(start), "-to", String(end), "-ac", "1", "-ar", "16000", file]);
    rows.push({ id: seg, source: id, lang: m.lang, kind: m.kind, start: +start.toFixed(2), end: +end.toFixed(2), file });
  }
}
writeFileSync(`${DIR}/segments.json`, JSON.stringify(rows, null, 2));
for (const r of rows) console.log(r.id, (r.end - r.start).toFixed(1));
