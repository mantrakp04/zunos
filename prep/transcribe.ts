import { readFileSync, writeFileSync } from "node:fs";

const REPO = "/Users/barreloflube/.t3/projects/synapse-md";
const { SarvamAIClient } = await import(`${REPO}/packages/speech/node_modules/sarvamai`);
const key = readFileSync(`${REPO}/.env`, "utf8").match(/^SARVAM_API_KEY=(.*)$/m)?.[1]?.replace(/^["']|["']$/g, "");
if (!key) throw new Error("no SARVAM_API_KEY");
const client = new SarvamAIClient({ apiSubscriptionKey: key });

const DIR = "/Users/barreloflube/voice-data/data";
const rows = JSON.parse(readFileSync(`${DIR}/segments.json`, "utf8"));
const code: Record<string, string> = { en: "en-IN", hi: "hi-IN", gu: "gu-IN" };

async function run(file: string, lang: string, mode: string) {
  const bytes = readFileSync(file);
  const res = await client.speechToText.transcribe({
    file: new File([bytes], "clip.wav", { type: "audio/wav" }),
    model: "saaras:v3",
    mode,
    language_code: code[lang],
  });
  return res.transcript as string;
}

async function retry(file: string, lang: string, mode: string) {
  for (let i = 0; ; i++) {
    try { return await run(file, lang, mode); } catch (e) { if (i >= 4) throw e; await Bun.sleep(2000 * (i + 1)); }
  }
}

const out: any[] = new Array(rows.length);
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < rows.length) {
    const i = next++;
    const r = rows[i];
    const verbatim = await retry(r.file, r.lang, "verbatim");
    const roman = r.lang === "en" ? verbatim : await retry(r.file, r.lang, "translit");
    out[i] = { ...r, verbatim, roman };
    process.stderr.write(".");
  }
}));
writeFileSync(`${DIR}/sarvam.json`, JSON.stringify(out, null, 2));
for (const r of out) console.log(`${r.id}\n  ${r.roman}${r.lang === "en" ? "" : `\n  ${r.verbatim}`}`);
