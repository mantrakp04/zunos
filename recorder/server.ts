import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { prompts } from "./prompts";

const DIR = "/Users/barreloflube/voice-data/data2";
mkdirSync(`${DIR}/clips`, { recursive: true });
const manifestPath = `${DIR}/manifest.json`;
const manifest: Record<string, unknown> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

Bun.serve({
  port: 4747,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(Bun.file(`${import.meta.dir}/index.html`));
    if (url.pathname === "/state") return Response.json({ prompts, done: Object.keys(manifest) });
    if (url.pathname.startsWith("/clips/")) return new Response(Bun.file(`${DIR}/clips/${url.pathname.slice(7)}`));
    if (url.pathname === "/save" && req.method === "POST") {
      const id = url.searchParams.get("id") ?? "";
      const prompt = prompts.find((p) => p.id === id);
      if (!prompt) return new Response("unknown id", { status: 400 });
      const audio = await req.arrayBuffer();
      writeFileSync(`${DIR}/clips/${id}.wav`, Buffer.from(audio));
      manifest[id] = {
        file: `clips/${id}.wav`,
        lang: prompt.lang,
        kind: prompt.kind,
        text: prompt.lines.join(" "),
        lines: prompt.lines,
        marks: JSON.parse(url.searchParams.get("marks") ?? "[]"),
        sampleRate: Number(url.searchParams.get("rate")),
        seconds: Number(url.searchParams.get("seconds")),
        recordedAt: new Date().toISOString(),
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log("http://localhost:4747");
