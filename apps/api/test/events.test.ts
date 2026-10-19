import { beforeEach, describe, expect, it } from "bun:test";
import { mockRunpod } from "../src/runpod";
import { call, getRow, resetState, sendEvent, sql, startedRun, stubFetch } from "./helpers";

beforeEach(async () => {
  await resetState();
  stubFetch();
});

/** PUTs the model like run.py does: curl -X PUT -H "Content-Type: application/x-tar" -T model.tar "$ZUNOS_MODEL_URL". */
const uploadModel = (url: string, body = "model bytes") =>
  call(url, { method: "PUT", raw: body, headers: { "content-type": "application/x-tar" } });

describe("pod events", () => {
  it("rejects missing or wrong tokens", async () => {
    const { id } = await startedRun();
    expect((await call(`/runs/${id}/events`, { method: "POST", body: { type: "log", line: "x" } })).status).toBe(401);
    const bad = await sendEvent(id, "0".repeat(64), { type: "log", line: "x" });
    expect(bad.status).toBe(401);
    expect(bad.json.code).toBe("unauthorized");
    // Another run's token doesn't work either.
    const other = await startedRun("tok-bob");
    expect((await sendEvent(id, other.podEnv.ZUNOS_EVENTS_TOKEN!, { type: "log", line: "x" })).status).toBe(401);
    // Nor does any token for a run that doesn't exist.
    expect((await sendEvent("nope", other.podEnv.ZUNOS_EVENTS_TOKEN!, { type: "log", line: "x" })).status).toBe(401);
  });

  it("stage → train → eval → done: records progress and terminates the pod", async () => {
    const { id, pod, podEnv } = await startedRun();
    const token = podEnv.ZUNOS_EVENTS_TOKEN!;

    let r = await sendEvent(id, token, { type: "stage", stage: "setup", status: "running" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, status: "running" });
    expect(getRow(id)).toMatchObject({ status: "running", stage: "setup" });

    await sendEvent(id, token, { type: "stage", stage: "train", status: "running" });
    for (let step = 1; step <= 3; step++)
      expect((await sendEvent(id, token, { type: "train", step, total: 3, loss: 1 / step, lr: 1e-5 })).status).toBe(200);
    await sendEvent(id, token, { type: "eval", step: 3, score: 4.2, res: { en: 3.1, hi: 5.0 } });
    await sendEvent(id, token, { type: "log", line: "hello from the pod" });

    let run = (await call(`/runs/${id}`, { token: "tok-alice" })).json;
    expect(run).toMatchObject({
      status: "running",
      stage: "train",
      steps: [
        { step: 1, loss: 1 },
        { step: 2, loss: 0.5 },
        { step: 3, loss: 1 / 3 },
      ],
      evals: [{ step: 3, score: 4.2, res: { en: 3.1, hi: 5.0 } }],
      modelUrl: null,
    });
    expect(JSON.parse(getRow(id).logs)).toEqual(["hello from the pod"]);
    expect(mockRunpod.terminated).toEqual([]);

    expect((await uploadModel(podEnv.ZUNOS_MODEL_URL!)).status).toBe(200);
    r = await sendEvent(id, token, { type: "done", best_step: 3, best_score: 4.2, model_bytes: 11 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, status: "done" });
    expect(mockRunpod.terminated).toEqual([pod.id]);

    const row = getRow(id);
    expect(row).toMatchObject({ status: "done", best_step: 3, best_score: 4.2, model_bytes: 11 });
    expect(row.finished_at).toBeGreaterThan(0);
    // The dataset is gone once the run finishes.
    expect((await call(podEnv.ZUNOS_DATASET_URL!)).status).toBe(404);

    run = (await call(`/runs/${id}`, { token: "tok-alice" })).json;
    expect(run.status).toBe("done");
    const model = new URL(run.modelUrl);
    expect(model.origin).toBe("https://api.zunos.test");
    expect(model.pathname).toBe(`/blobs/runs/${id}/model.tar`);
    expect(Number(model.searchParams.get("exp")) - Date.now() / 1000).toBeGreaterThan(24 * 3600 - 5);

    // The Mac app downloads it with a plain GET.
    const download = await call(run.modelUrl);
    expect(download.status).toBe(200);
    expect(download.res.headers.get("content-type")).toBe("application/x-tar");
    expect(download.text).toBe("model bytes");

    // Late events are refused so the pod stops.
    expect((await sendEvent(id, token, { type: "log", line: "late" })).json.code).toBe("run_finished");
  });

  it("done uses the stored model size when the pod doesn't send one", async () => {
    const { id, podEnv } = await startedRun();
    await uploadModel(podEnv.ZUNOS_MODEL_URL!, "123456");
    await sendEvent(id, podEnv.ZUNOS_EVENTS_TOKEN!, { type: "done" });
    expect(getRow(id)).toMatchObject({ status: "done", model_bytes: 6, best_step: null });
  });

  it("done without an uploaded model fails the run", async () => {
    const { id, pod, podEnv } = await startedRun();
    await sendEvent(id, podEnv.ZUNOS_EVENTS_TOKEN!, { type: "done", best_step: 1, best_score: 9, model_bytes: 1 });
    expect(getRow(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/model/) });
    expect(mockRunpod.terminated).toEqual([pod.id]);
  });

  it("error fails the run and terminates the pod", async () => {
    const { id, pod, podEnv } = await startedRun();
    await sendEvent(id, podEnv.ZUNOS_EVENTS_TOKEN!, { type: "error", message: "CUDA out of memory" });
    const run = (await call(`/runs/${id}`, { token: "tok-alice" })).json;
    expect(run).toMatchObject({ status: "failed", error: "CUDA out of memory", modelUrl: null });
    expect(mockRunpod.terminated).toEqual([pod.id]);
  });

  it("keeps the last 500 steps and 200 log lines", async () => {
    const { id, podEnv } = await startedRun();
    const many = Array.from({ length: 600 }, (_, i) => ({ step: i, loss: 1 }));
    sql(
      "UPDATE runs SET steps = ?, logs = ? WHERE id = ?",
      JSON.stringify(many),
      JSON.stringify(Array.from({ length: 250 }, (_, i) => `l${i}`)),
      id,
    );
    await sendEvent(id, podEnv.ZUNOS_EVENTS_TOKEN!, { type: "train", step: 600, total: 900, loss: 0.1, lr: 1e-5 });
    await sendEvent(id, podEnv.ZUNOS_EVENTS_TOKEN!, { type: "log", line: "last" });
    const row = getRow(id);
    const steps = JSON.parse(row.steps);
    expect(steps).toHaveLength(500);
    expect(steps.at(-1)).toEqual({ step: 600, loss: 0.1 });
    const logs = JSON.parse(row.logs);
    expect(logs).toHaveLength(200);
    expect(logs.at(-1)).toBe("last");
  });

  it("validates event bodies and updates last_event_at", async () => {
    const { id, podEnv, row } = await startedRun();
    const token = podEnv.ZUNOS_EVENTS_TOKEN!;
    expect((await sendEvent(id, token, { type: "stage", stage: "bogus" })).status).toBe(400);
    expect((await sendEvent(id, token, { type: "train", step: "1" })).status).toBe(400);
    expect((await sendEvent(id, token, { type: "wat" })).status).toBe(400);
    expect((await sendEvent(id, token, [1, 2])).status).toBe(400);
    sql("UPDATE runs SET last_event_at = 1 WHERE id = ?", id);
    await sendEvent(id, token, { type: "log", line: "x" });
    expect(getRow(id).last_event_at).toBeGreaterThanOrEqual(row.started_at!);
  });
});
