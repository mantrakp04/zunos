// Progress reports from the training pod: POST /runs/:id/events with `Authorization: Bearer <events token>`.
import { Hono } from "hono";
import { BILLING, type RunRow, getRun, parseJson, updateRun } from "./db";
import type { AppEnv } from "./env";
import { fail, isNum, isObject, readJson } from "./http";
import { constantTimeEqual, finishRun, sha256Hex } from "./lifecycle";
import { keys } from "./r2";

const STAGES = new Set(["setup", "data", "gen", "filter", "train", "export", "upload"]);
const MAX_STEPS = 500;
const MAX_LOGS = 200;
const MAX_LINE = 2000;

export const events = new Hono<AppEnv>();

const append = <T>(json: string, item: T, max: number) => JSON.stringify([...parseJson<T[]>(json, []), item].slice(-max));

events.post("/runs/:id/events", async (c) => {
  const env = c.env;
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const row = await getRun(env, c.req.param("id"));
  const hash = token ? await sha256Hex(token) : "";
  if (!row || !row.events_token_hash || !token || !constantTimeEqual(hash, row.events_token_hash))
    fail(401, "unauthorized", "Bad events token.");
  const run = row as RunRow;
  // A finished run tells the pod to give up (it is being or has been terminated).
  if (!BILLING.includes(run.status)) fail(409, "run_finished", `Run is ${run.status}.`);

  const ev = await readJson(c);
  if (!isObject(ev) || typeof ev.type !== "string") return fail(400, "bad_request", "Event needs a type.");

  const now = Date.now();
  const fields: Partial<RunRow> = { last_event_at: now };
  if (run.status === "queued") fields.status = "running";

  switch (ev.type) {
    case "stage": {
      if (typeof ev.stage !== "string" || !STAGES.has(ev.stage)) fail(400, "bad_request", "Unknown stage.");
      fields.stage = ev.stage as string;
      break;
    }
    case "train": {
      if (!isNum(ev.step) || !isNum(ev.loss)) fail(400, "bad_request", "train events need numeric step and loss.");
      fields.steps = append(run.steps, { step: ev.step, loss: ev.loss }, MAX_STEPS);
      break;
    }
    case "eval": {
      if (!isNum(ev.step) || !isNum(ev.score)) fail(400, "bad_request", "eval events need numeric step and score.");
      const res = isObject(ev.res) ? ev.res : {};
      fields.evals = append(run.evals, { step: ev.step, score: ev.score, res }, 1000);
      break;
    }
    case "log": {
      if (typeof ev.line !== "string") fail(400, "bad_request", "log events need a line.");
      fields.logs = append(run.logs, (ev.line as string).slice(0, MAX_LINE), MAX_LOGS);
      break;
    }
    case "done": {
      const model = await env.BUCKET.head(keys.model(run.id));
      if (!model) {
        const updated = await finishRun(env, run, "failed", {
          error: "Training finished but the model never arrived.",
          reason: "done without model upload",
          extra: { last_event_at: now },
          now,
        });
        return c.json({ ok: true, status: updated.status });
      }
      const updated = await finishRun(env, run, "done", {
        reason: "training done",
        extra: {
          last_event_at: now,
          best_step: isNum(ev.best_step) ? Math.round(ev.best_step) : null,
          best_score: isNum(ev.best_score) ? ev.best_score : null,
          model_bytes: isNum(ev.model_bytes) ? Math.round(ev.model_bytes) : model.size,
        },
        now,
      });
      return c.json({ ok: true, status: updated.status });
    }
    case "error": {
      const message = typeof ev.message === "string" && ev.message ? ev.message.slice(0, MAX_LINE) : "Training failed.";
      const updated = await finishRun(env, run, "failed", {
        error: message,
        reason: "pod reported error",
        extra: { last_event_at: now },
        now,
      });
      return c.json({ ok: true, status: updated.status });
    }
    default:
      fail(400, "bad_request", `Unknown event type ${ev.type}.`);
  }

  // Only while still billing: a concurrent stop/reaper wins.
  if (!(await updateRun(env, run.id, fields, BILLING))) fail(409, "run_finished", "Run has finished.");
  return c.json({ ok: true, status: fields.status ?? run.status });
});
