import { randomUUID } from "node:crypto";
import { requireUser } from "./auth";
import { HOUR, keys, presign } from "./blobs";
import { type Choice, chooseGpu, quoteBody } from "./budget";
import { ACTIVE, type RemoteRun, type RunRow, activeRunFor, getRun, insertRun, toRemoteRun, updateRun } from "./db";
import { type Ctx, type Env, MIN_CUDA, POD_PREFIX, type User, settings } from "./env";
import { fail, isObject, readJson } from "./http";
import { finishRun, randomHex, sha256Hex, terminatePod } from "./lifecycle";
import { type CreatePodRequest, RunpodError, runpod } from "./runpod";

const LANGS = new Set(["en", "hi", "gu"]);
const ACTIVE_RUN_MESSAGE = "You already have a training run in progress.";

function ownRun(ctx: Ctx, user: User, id: string): RunRow {
  const row = getRun(ctx, id);
  if (!row || row.user_id !== user.id) return fail(404, "not_found", "Training run not found.");
  return row;
}

async function choice(ctx: Ctx): Promise<Choice> {
  try {
    return await chooseGpu(ctx, runpod(ctx.env));
  } catch (e) {
    console.error("runpod catalog/pods read failed", String(e));
    return fail(503, "provider_unavailable", "The GPU provider isn't responding. Try again in a few minutes.");
  }
}

/** Refuses with 503 not_configured when any of these settings is empty. */
function requireConfigured(env: Env, required: (keyof Env)[]) {
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error(JSON.stringify({ msg: "not configured", missing }));
    fail(503, "not_configured", "Cloud training isn't set up on the server yet.");
  }
}

export async function quote(ctx: Ctx, request: Request) {
  const user = await requireUser(ctx.env, request);
  const pick = await choice(ctx);
  const active = activeRunFor(ctx, user.id);
  return quoteBody(pick, active ? { available: false, reason: ACTIVE_RUN_MESSAGE } : undefined);
}

export async function createRun(ctx: Ctx, request: Request): Promise<{ id: string; uploadUrl: string }> {
  const user = await requireUser(ctx.env, request);
  const body = await readJson(request);
  const langs = isObject(body) ? body.langs : undefined;
  if (!Array.isArray(langs) || !langs.length || !langs.every((l) => typeof l === "string" && LANGS.has(l)))
    fail(400, "bad_request", 'langs must be a non-empty list of "en", "hi", "gu".');
  // Without these the upload URL would point nowhere.
  requireConfigured(ctx.env, ["PUBLIC_URL", "BLOB_SIGNING_SECRET"]);
  if (activeRunFor(ctx, user.id)) fail(409, "run_active", ACTIVE_RUN_MESSAGE);

  const id = randomUUID();
  try {
    insertRun(ctx, {
      id,
      user_id: user.id,
      email: user.email,
      langs: JSON.stringify([...new Set(langs as string[])]),
      created_at: Date.now(),
    });
  } catch (e) {
    // runs_one_active_per_user: a concurrent request won the race.
    if (String(e).includes("UNIQUE")) fail(409, "run_active", ACTIVE_RUN_MESSAGE);
    throw e;
  }
  return { id, uploadUrl: presign(ctx.env, keys.dataset(id), "PUT", HOUR) };
}

export async function readRun(ctx: Ctx, request: Request, id: string): Promise<RemoteRun> {
  const row = ownRun(ctx, await requireUser(ctx.env, request), id);
  return toRemoteRun(ctx, row);
}

export async function startRun(ctx: Ctx, request: Request, id: string): Promise<RemoteRun> {
  const env = ctx.env;
  const s = settings(env);
  let row = ownRun(ctx, await requireUser(env, request), id);
  if (row.status !== "uploading") fail(409, "bad_state", `This run is already ${row.status}.`);
  // A pod launched without these would bill while unable to fetch its code or report back.
  requireConfigured(env, s.mock ? ["PUBLIC_URL", "BLOB_SIGNING_SECRET"] : ["PUBLIC_URL", "BLOB_SIGNING_SECRET", "RUNPOD_API_KEY"]);
  if (!(await ctx.blobs.head(keys.code))) {
    console.error(JSON.stringify({ msg: "not configured", missing: [keys.code] }));
    fail(503, "not_configured", "Cloud training isn't set up on the server yet.");
  }

  const dataset = await ctx.blobs.head(keys.dataset(row.id));
  if (!dataset || dataset.size === 0) fail(409, "dataset_missing", "The recordings haven't finished uploading.");

  const pick = await choice(ctx);
  if (!pick.candidates.length) fail(503, pick.code ?? "no_capacity", pick.reason ?? "No GPU is available right now.");

  // Claim the run before creating a pod: blocks a double start, and the reaper's orphan sweep keeps a pod
  // whose name matches an active run even before its pod_id is saved.
  const now = Date.now();
  if (!updateRun(ctx, row.id, { status: "queued", started_at: now, last_event_at: now }, ["uploading"]))
    fail(409, "bad_state", "This run is already starting.");

  const token = randomHex(32);
  const sixHours = 6 * HOUR;
  const podEnv: Record<string, string> = {
    ZUNOS_RUN_ID: row.id,
    ZUNOS_BOOTSTRAP_URL: `${s.publicUrl}/pod/bootstrap.sh`,
    ZUNOS_CODE_URL: presign(env, keys.code, "GET", sixHours),
    ZUNOS_DATASET_URL: presign(env, keys.dataset(row.id), "GET", sixHours),
    ZUNOS_MODEL_URL: presign(env, keys.model(row.id), "PUT", sixHours),
    ZUNOS_EVENTS_URL: `${s.publicUrl}/runs/${row.id}/events`,
    ZUNOS_EVENTS_TOKEN: token,
  };
  if (env.HF_TOKEN) podEnv.HF_TOKEN = env.HF_TOKEN;

  const rp = runpod(env);
  let lastError: RunpodError | null = null;
  for (const gpu of pick.candidates) {
    const req: CreatePodRequest = {
      name: `${POD_PREFIX}${row.id}`,
      cloud: "SECURE",
      image: s.podImage,
      gpu: { id: gpu.id, count: 1, minCudaVersion: MIN_CUDA },
      disk: 150,
      ports: [],
      env: podEnv,
      entrypoint: ["bash", "-c"],
      cmd: ['curl -fsSL "$ZUNOS_BOOTSTRAP_URL" | bash'],
    };
    let pod: { id: string; costPerHour: number | null };
    try {
      pod = await rp.createPod(req);
    } catch (e) {
      lastError = e instanceof RunpodError ? e : new RunpodError(0, String(e));
      console.warn(JSON.stringify({ msg: "createPod failed", runId: row.id, gpu: gpu.id, error: lastError.message }));
      if (lastError.tryNextGpu) continue;
      break;
    }

    const started = Date.now();
    const price = pod.costPerHour && pod.costPerHour > 0 ? pod.costPerHour : gpu.pricePerHour;
    try {
      updateRun(ctx, row.id, {
        pod_id: pod.id,
        gpu: gpu.id,
        price_per_hour: price,
        events_token_hash: sha256Hex(token),
        started_at: started,
        last_event_at: started,
      });
    } catch (e) {
      await terminatePod(rp, pod.id, `run ${row.id}: could not save pod id`);
      throw e;
    }
    console.log(JSON.stringify({ msg: "pod created", runId: row.id, podId: pod.id, gpu: gpu.id, pricePerHour: price }));
    row = getRun(ctx, row.id)!;
    return toRemoteRun(ctx, row);
  }

  // No pod: release the claim so the user can try again.
  updateRun(ctx, row.id, { status: "uploading", started_at: null, last_event_at: null }, ["queued"]);
  if (lastError?.status === 402) {
    console.error(JSON.stringify({ msg: "runpod balance too low", runId: row.id }));
    fail(503, "provider_error", "Training is unavailable right now.");
  }
  if (lastError?.tryNextGpu) fail(503, "no_capacity", "No training GPUs are free right now. Try again in a few minutes.");
  return fail(503, "provider_unavailable", "The GPU provider isn't responding. Try again in a few minutes.");
}

export async function stopRun(ctx: Ctx, request: Request, id: string): Promise<RemoteRun> {
  let row = ownRun(ctx, await requireUser(ctx.env, request), id);
  if (ACTIVE.includes(row.status)) row = await finishRun(ctx, row, "stopped", { reason: "stopped by user" });
  return toRemoteRun(ctx, row);
}
