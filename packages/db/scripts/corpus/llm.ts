// OpenAI-compatible chat client for the corpus generator: a global concurrency limit, retries with
// backoff, JSON-only answers, and an on-disk cache keyed by the request so an interrupted run resumes
// where it stopped. The API key, if any, is read from CORPUS_API_KEY and never written anywhere.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LLM_URL = (process.env.CORPUS_LLM_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, "");
export const MODEL = process.env.CORPUS_MODEL ?? "gpt-6.1-sol";
export const REVIEW_MODEL = process.env.CORPUS_REVIEW_MODEL ?? MODEL;
const EFFORT = process.env.CORPUS_REASONING ?? "high";
const CONCURRENCY = Number(process.env.CORPUS_CONCURRENCY ?? 6);
const TIMEOUT_MS = Number(process.env.CORPUS_TIMEOUT_MS ?? 15 * 60_000);
const ATTEMPTS = 6;

export const CACHE_DIR = process.env.CORPUS_CACHE ?? join(import.meta.dir, ".cache");
const CALLS = join(CACHE_DIR, "calls");
mkdirSync(CALLS, { recursive: true });

let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export const stats = { calls: 0, cached: 0, retries: 0, promptTokens: 0, completionTokens: 0 };

export type Msg = { role: "system" | "user" | "assistant"; content: string };

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("answer is not JSON");
  }
}

/**
 * Ask for a JSON object. `validate` throws on a malformed answer, which counts as a failed attempt
 * (retried with the error appended). `tag` only names the cache file for humans; the key is the request.
 */
export async function askJson<T>(
  messages: Msg[],
  validate: (x: any) => T,
  opts: { tag: string; model?: string; effort?: string; fresh?: boolean } = { tag: "call" },
): Promise<T> {
  const model = opts.model ?? MODEL;
  const effort = opts.effort ?? EFFORT;
  const key = createHash("sha256").update(JSON.stringify({ model, effort, messages })).digest("hex").slice(0, 24);
  const file = join(CALLS, `${opts.tag.replace(/[^\w.-]+/g, "_").slice(0, 60)}-${key}.json`);
  if (!opts.fresh && existsSync(file)) {
    try {
      const hit = validate(JSON.parse(readFileSync(file, "utf8")).answer);
      stats.cached++;
      return hit;
    } catch {
      // stale or invalid cache entry: ask again
    }
  }
  let convo = messages;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const content = await slot(() => post(model, effort, convo));
      let parsed: unknown;
      try {
        parsed = parseJson(content);
        const value = validate(parsed);
        writeFileSync(file, JSON.stringify({ tag: opts.tag, model, effort, at: new Date().toISOString(), answer: parsed }));
        return value;
      } catch (e) {
        // Show the model its own answer and what was wrong with it.
        convo = [...messages, { role: "assistant", content }, {
          role: "user",
          content: `That answer could not be used: ${(e as Error).message}. Reply again with the complete corrected JSON object only.`,
        }];
        throw e;
      }
    } catch (e) {
      lastErr = e;
      stats.retries++;
      const wait = Math.min(120_000, 2_000 * 2 ** (attempt - 1)) * (0.75 + Math.random() / 2);
      console.warn(`  ! ${opts.tag} attempt ${attempt}/${ATTEMPTS}: ${(e as Error).message.slice(0, 200)}`);
      if (attempt < ATTEMPTS) await Bun.sleep(wait);
    }
  }
  throw new Error(`${opts.tag}: gave up after ${ATTEMPTS} attempts: ${(lastErr as Error)?.message}`);
}

async function post(model: string, effort: string, messages: Msg[]): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.CORPUS_API_KEY) headers.authorization = `Bearer ${process.env.CORPUS_API_KEY}`;
  const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ model, messages, reasoning_effort: effort, response_format: { type: "json_object" } }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  stats.calls++;
  stats.promptTokens += data.usage?.prompt_tokens ?? 0;
  stats.completionTokens += data.usage?.completion_tokens ?? 0;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("empty answer");
  if (data.choices[0].finish_reason === "length") throw new Error("answer was cut off (length)");
  return content;
}
