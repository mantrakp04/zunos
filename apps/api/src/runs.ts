import { Hono } from "hono";
import { requireUser } from "./auth";
import { type Choice, chooseGpu, quoteBody } from "./budget";
import { ACTIVE, type RunRow, activeRunFor, getRun, toRemoteRun, updateRun } from "./db";
import { type AppEnv, type Env, MIN_CUDA, POD_PREFIX, type User, settings } from "./env";
import { fail, isObject, readJson } from "./http";
import { finishRun, randomHex, sha256Hex, terminatePod } from "./lifecycle";
import { HOUR, keys, presign } from "./r2";
import { type CreatePodRequest, RunpodError, runpod } from "./runpod";

const LANGS = new Set(["en", "hi", "gu"]);
const ACTIVE_RUN_MESSAGE = "You already have a training run in progress.";

export const runs = new Hono<AppEnv>();

async function ownRun(env: Env, user: User, id: string): Promise<RunRow> {
  const row = await getRun(env, id);
  if (!row || row.user_id !== user.id) return fail(404, "not_found", "Training run not found.");
  return row;
}

async function choice(env: Env): Promise<Choice> {
  try {
    return await chooseGpu(env, runpod(env));
  } catch (e) {
    console.error("runpod catalog/pods read failed", String(e));
    return fail(503, "provider_unavailable", "The GPU provider isn't responding. Try again in a few minutes.");
  }
}

runs.get("/quote", requireUser, async (c) => {
  const user = c.get("user");
  const [pick, active] = await Promise.all([choice(c.env), activeRunFor(c.env, user.id)]);
  return c.json(quoteBody(pick, active ? { available: false, reason: ACTIVE_RUN_MESSAGE } : undefined));
});

runs.post("/runs", requireUser, async (c) => {
  const user = c.get("user");
  const body = await readJson(c);
  const langs = isObject(body) ? body.langs : undefined;
  if (!Array.isArray(langs) || !langs.length || !langs.every((l) => typeof l === "string" && LANGS.has(l)))
    fail(400, "bad_request", 'langs must be a non-empty list of "en", "hi", "gu".');
  if (await activeRunFor(c.env, user.id)) fail(409, "run_active", ACTIVE_RUN_MESSAGE);

  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      "INSERT INTO runs (id, user_id, email, langs, status, created_at) VALUES (?, ?, ?, ?, 'uploading', ?)",
    )
      .bind(id, user.id, user.email, JSON.stringify([...new Set(langs as string[])]), Date.now())
      .run();
  } catch (e) {
    // runs_one_active_per_user: a concurrent request won the race.
    if (String(e).includes("UNIQUE")) fail(409, "run_active", ACTIVE_RUN_MESSAGE);
    throw e;
  }
  return c.json({ id, uploadUrl: await presign(c.env, keys.dataset(id), "PUT", HOUR) }, 201);
});

runs.get("/runs/:id", requireUser, async (c) => {
  const row = await ownRun(c.env, c.get("user"), c.req.param("id"));
  return c.json(await toRemoteRun(c.env, row));
});

runs.post("/runs/:id/start", requireUser, async (c) => {
  const env = c.env;
  const s = settings(env);
  let row = await ownRun(env, c.get("user"), c.req.param("id"));
  if (row.status !== "uploading") fail(409, "bad_state", `This run is already ${row.status}.`);
  // A pod launched without these would bill while unable to fetch its code or report back.
  const required: (keyof Env)[] = ["PUBLIC_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
  if (!s.mock) required.push("RUNPOD_API_KEY");
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error(JSON.stringify({ msg: "not configured", missing }));
    fail(503, "not_configured", "Cloud training isn't set up on the server yet.");
  }

  const dataset = await env.BUCKET.head(keys.dataset(row.id));
  if (!dataset || dataset.size === 0) fail(409, "dataset_missing", "The recordings haven't finished uploading.");

  const pick = await choice(env);
  if (!pick.candidates.length) fail(503, pick.code ?? "no_capacity", pick.reason ?? "No GPU is available right now.");

  // Claim the run before creating a pod: blocks a double start, and the reaper's orphan sweep keeps a pod
  // whose name matches an active run even before its pod_id is saved.
  const now = Date.now();
  if (!(await updateRun(env, row.id, { status: "queued", started_at: now, last_event_at: now }, ["uploading"])))
    fail(409, "bad_state", "This run is already starting.");

  const token = randomHex(32);
  const sixHours = 6 * HOUR;
  const [codeUrl, datasetUrl, modelUrl] = await Promise.all([
    presign(env, keys.code, "GET", sixHours),
    presign(env, keys.dataset(row.id), "GET", sixHours),
    presign(env, keys.model(row.id), "PUT", sixHours),
  ]);
  const podEnv: Record<string, string> = {
    ZUNOS_RUN_ID: row.id,
    ZUNOS_BOOTSTRAP_URL: `${s.publicUrl}/pod/bootstrap.sh`,
    ZUNOS_CODE_URL: codeUrl,
    ZUNOS_DATASET_URL: datasetUrl,
    ZUNOS_MODEL_URL: modelUrl,
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
      await updateRun(env, row.id, {
        pod_id: pod.id,
        gpu: gpu.id,
        price_per_hour: price,
        events_token_hash: await sha256Hex(token),
        started_at: started,
        last_event_at: started,
      });
    } catch (e) {
      await terminatePod(rp, pod.id, `run ${row.id}: could not save pod id`);
      throw e;
    }
    console.log(JSON.stringify({ msg: "pod created", runId: row.id, podId: pod.id, gpu: gpu.id, pricePerHour: price }));
    row = (await getRun(env, row.id))!;
    return c.json(await toRemoteRun(env, row));
  }

  // No pod: release the claim so the user can try again.
  await updateRun(env, row.id, { status: "uploading", started_at: null, last_event_at: null }, ["queued"]);
  if (lastError?.status === 402) {
    console.error(JSON.stringify({ msg: "runpod balance too low", runId: row.id }));
    fail(503, "provider_error", "Training is unavailable right now.");
  }
  if (lastError?.tryNextGpu) fail(503, "no_capacity", "No training GPUs are free right now. Try again in a few minutes.");
  return fail(503, "provider_unavailable", "The GPU provider isn't responding. Try again in a few minutes.");
});

runs.post("/runs/:id/stop", requireUser, async (c) => {
  let row = await ownRun(c.env, c.get("user"), c.req.param("id"));
  if (ACTIVE.includes(row.status)) row = await finishRun(c.env, row, "stopped", { reason: "stopped by user" });
  return c.json(await toRemoteRun(c.env, row));
});
