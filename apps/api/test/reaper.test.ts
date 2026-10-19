import { beforeEach, describe, expect, it } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_KEEP_MS, reap, startReaper } from "../src/reaper";
import { mockRunpod } from "../src/runpod";
import { blobs, call, ctx, getRow, resetState, sendEvent, sql, startedRun, stubFetch, testCtx } from "./helpers";

const MIN = 60_000;

beforeEach(async () => {
  await resetState();
  stubFetch();
});

const setTimes = (id: string, started: number, lastEvent: number, status = "running") =>
  sql("UPDATE runs SET started_at = ?, last_event_at = ?, status = ? WHERE id = ?", started, lastEvent, status, id);

describe("reaper", () => {
  it("fails a running run with no event for 30 minutes and terminates its pod", async () => {
    const { id, pod } = await startedRun();
    const now = Date.now();
    setTimes(id, now - 40 * MIN, now - 31 * MIN);
    const report = await reap(testCtx(), now);
    expect(report.failed).toEqual([{ runId: id, reason: "no event for 30 min" }]);
    expect(mockRunpod.terminated).toEqual([pod.id]);
    expect(getRow(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/30 minutes/) });
  });

  it("gives queued runs 45 minutes for setup", async () => {
    const { id, pod } = await startedRun();
    const now = Date.now();
    setTimes(id, now - 40 * MIN, now - 40 * MIN, "queued");
    expect((await reap(testCtx(), now)).failed).toEqual([]);
    expect(mockRunpod.pods.has(pod.id)).toBe(true);
    setTimes(id, now - 46 * MIN, now - 46 * MIN, "queued");
    expect((await reap(testCtx(), now)).failed).toEqual([{ runId: id, reason: "no event for 45 min" }]);
    expect(mockRunpod.terminated).toEqual([pod.id]);
  });

  it("leaves healthy runs alone", async () => {
    const { id, podEnv } = await startedRun();
    await sendEvent(id, podEnv.ZUNOS_EVENTS_TOKEN!, { type: "stage", stage: "setup", status: "running" });
    const report = await reap(testCtx());
    expect(report).toEqual({ failed: [], orphansTerminated: [], podsListed: true, blobsDeleted: [] });
    expect(getRow(id).status).toBe("running");
    expect(await blobs.head(`runs/${id}/dataset.tar.gz`)).not.toBeNull();
  });

  it("stops runs longer than MAX_RUN_HOURS", async () => {
    const { id, pod } = await startedRun();
    const now = Date.now();
    setTimes(id, now - 4.1 * 60 * MIN, now - 1 * MIN);
    const report = await reap(testCtx(), now);
    expect(report.failed).toEqual([{ runId: id, reason: "over 4 h" }]);
    expect(mockRunpod.terminated).toEqual([pod.id]);
  });

  it("stops the newest runs when the hourly total exceeds MAX_HOURLY_USD", async () => {
    const a = await startedRun("tok-alice"); // A40 $0.44
    const b = await startedRun("tok-bob"); // A40 $0.44
    const now = Date.now();
    setTimes(a.id, now - 20 * MIN, now - MIN);
    setTimes(b.id, now - 10 * MIN, now - MIN);
    const report = await reap(testCtx({ MAX_HOURLY_USD: "0.5" }), now);
    expect(report.failed).toEqual([{ runId: b.id, reason: "over hourly budget" }]);
    expect(mockRunpod.terminated).toEqual([b.pod.id]);
    expect(getRow(a.id).status).toBe("running");
  });

  it("terminates zunos pods without an active run and never touches other pods", async () => {
    const { id, pod } = await startedRun();
    const fake = (podId: string, name: string) =>
      mockRunpod.pods.set(podId, { id: podId, name, status: "RUNNING", costPerHour: 0.3, request: {} as never });
    fake("orphan-1", "zunos-run-00000000-dead-beef-0000-000000000000");
    fake("owner-1", "my-experiment");
    // A finished run whose terminate was missed.
    sql("UPDATE runs SET status = 'stopped' WHERE id = ?", id);

    const report = await reap(testCtx());
    expect(report.orphansTerminated.sort()).toEqual(["orphan-1", pod.id].sort());
    expect(mockRunpod.pods.has("owner-1")).toBe(true);
  });

  it("keeps a pod whose run is claimed but has no pod id yet", async () => {
    const { id, pod } = await startedRun();
    sql("UPDATE runs SET pod_id = NULL WHERE id = ?", id);
    expect((await reap(testCtx())).orphansTerminated).toEqual([]);
    expect(mockRunpod.pods.has(pod.id)).toBe(true);
  });

  it("expires abandoned uploads and deletes their dataset", async () => {
    const now = Date.now();
    sql(
      "INSERT INTO runs (id, user_id, email, langs, status, created_at) VALUES ('old', 'u-x', 'x', '[]', 'uploading', ?)",
      now - 4 * 60 * MIN,
    );
    await blobs.put("runs/old/dataset.tar.gz", "half an upload");
    expect((await reap(testCtx(), now)).failed).toEqual([{ runId: "old", reason: "upload abandoned" }]);
    expect(await blobs.head("runs/old/dataset.tar.gz")).toBeNull();
  });

  it("deletes a dataset that landed after its run finished", async () => {
    const { id } = await startedRun();
    await call(`/runs/${id}/stop`, { token: "tok-alice", method: "POST" });
    await blobs.put(`runs/${id}/dataset.tar.gz`, "late");
    const report = await reap(testCtx());
    expect(report.blobsDeleted).toEqual([`runs/${id}/dataset.tar.gz`]);
    expect(await blobs.head(`runs/${id}/dataset.tar.gz`)).toBeNull();
  });

  it("deletes a finished run's model.tar 7 days after it finished", async () => {
    const { id, podEnv } = await startedRun();
    await call(podEnv.ZUNOS_MODEL_URL!, { method: "PUT", raw: "model", headers: { "content-type": "application/x-tar" } });
    await sendEvent(id, podEnv.ZUNOS_EVENTS_TOKEN!, { type: "done" });
    const finished = getRow(id).finished_at!;

    expect((await reap(testCtx(), finished + MODEL_KEEP_MS - MIN)).blobsDeleted).toEqual([]);
    expect((await call(`/runs/${id}`, { token: "tok-alice" })).json.modelUrl).toEqual(expect.any(String));

    expect((await reap(testCtx(), finished + MODEL_KEEP_MS + MIN)).blobsDeleted).toEqual([`runs/${id}/model.tar`]);
    expect(await blobs.head(`runs/${id}/model.tar`)).toBeNull();
    // The run stays done, but there is nothing left to download.
    expect((await call(`/runs/${id}`, { token: "tok-alice" })).json).toMatchObject({ status: "done", modelUrl: null });
  });

  it("removes temp files left by uploads that died more than a day ago", async () => {
    const tmp = join(blobs.root, ".tmp");
    writeFileSync(join(tmp, "old"), "x");
    writeFileSync(join(tmp, "fresh"), "x");
    const dayAgo = (Date.now() - 25 * 60 * MIN) / 1000;
    utimesSync(join(tmp, "old"), dayAgo, dayAgo);
    await reap(testCtx());
    expect(await Bun.file(join(tmp, "old")).exists()).toBe(false);
    expect(await Bun.file(join(tmp, "fresh")).exists()).toBe(true);
  });

  it("runs once at startup and then on its interval", async () => {
    const first = await startedRun("tok-alice");
    setTimes(first.id, Date.now() - 60 * MIN, Date.now() - 60 * MIN);
    const reaper = startReaper(ctx, 40);
    try {
      await reaper.first;
      expect(mockRunpod.terminated).toEqual([first.pod.id]);
      expect(getRow(first.id).status).toBe("failed");

      const second = await startedRun("tok-bob");
      setTimes(second.id, Date.now() - 60 * MIN, Date.now() - 60 * MIN);
      await Bun.sleep(150);
      expect(getRow(second.id).status).toBe("failed");
      expect(mockRunpod.terminated).toEqual([first.pod.id, second.pod.id]);
    } finally {
      reaper.stop();
    }
  });
});
