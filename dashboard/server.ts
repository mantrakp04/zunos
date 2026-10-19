import { mkdirSync, existsSync } from "node:fs";

const DIR = import.meta.dir;
const SAMPLES = `${DIR}/samples`;
mkdirSync(SAMPLES, { recursive: true });
const POD_STARTED = Date.parse("2026-10-18T18:28:05Z");
const RATE = 0.99;
let latest: any = { error: "starting" };

async function poll() {
  try {
    const p = Bun.spawn(["ssh", "-o", "ConnectTimeout=10", "asr", "python3 /workspace/code/status.py"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    const data = JSON.parse(text);
    data.cost = +(((Date.now() - POD_STARTED) / 3600000) * RATE).toFixed(2);
    data.uptimeH = +((Date.now() - POD_STARTED) / 3600000).toFixed(2);
    data.fetchedAt = Date.now();
    const missing = (data.samples ?? []).filter((s: any) => !existsSync(`${SAMPLES}/${s.id}.wav`));
    if (missing.length) {
      Bun.spawnSync(["scp", "-q", ...missing.map((s: any) => `asr:/workspace/data/synth/${s.id}.wav`), `${SAMPLES}/`]);
    }
    latest = data;
  } catch (e) {
    latest = { ...latest, error: `pod unreachable: ${e}`, fetchedAt: Date.now() };
  }
}
import { readFileSync } from "node:fs";
if (process.argv.includes("--live")) {
  await poll();
  setInterval(poll, 15000);
} else {
  latest = JSON.parse(readFileSync(`${DIR}/final.json`, "utf8"));
  latest.cost = 6.49;
  latest.fetchedAt = Date.now();
}

Bun.serve({
  port: 4848,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(Bun.file(`${DIR}/index.html`));
    if (url.pathname === "/status") return Response.json(latest);
    if (url.pathname.startsWith("/samples/")) return new Response(Bun.file(`${SAMPLES}/${url.pathname.slice(9)}`));
    if (url.pathname.startsWith("/real/")) return new Response(Bun.file(`/Users/barreloflube/voice-data/data/final/48k/${url.pathname.slice(6)}`));
    return new Response("not found", { status: 404 });
  },
});
console.log("http://localhost:4848");
