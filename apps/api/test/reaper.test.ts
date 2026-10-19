import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { reap } from "../src/reaper";
import { mockRunpod } from "../src/runpod";
import { getRow, resetState, sendEvent, startedRun, stubFetch, testEnv } from "./helpers";

const MIN = 60_000;

beforeEach(async () => {
  await resetState();
  stubFetch();
});

const setTimes = (id: string, started: number, lastEvent: number, status = "running") =>
  env.DB.prepare("UPDATE runs SET started_at = ?, last_event_at = ?, status = ? WHERE id = ?")
    .bind(started, lastEvent, status, id)
    .run();

describe("reaper", () => {
  it("fails a running run with no event for 30 minutes and terminates its pod", async () => {
    const { id, pod } = await startedRun();
    const now = Date.now();
    await setTimes(id, now - 40 * MIN, now - 31 * MIN);
    const report = await reap(testEnv(), now);
    expect(report.failed).toEqual([{ runId: id, reason: "no event for 30 min" }]);
    expect(mockRunpod.terminated).toEqual([pod.id]);
    expect(await getRow(id)).toMatchObject({ status: "failed", error: expect.stringMatching(/30 minutes/) });
  });

  it("gives queued runs 45 minutes for setup", async () => {
    const { id, pod } = await startedRun();
    const now = Date.now();
    await setTimes(id, now - 40 * MIN, now - 40 * MIN, "queued");
    expect((await reap(testEnv(), now)).failed).toEqual([]);
    expect(mockRunpod.pods.has(pod.id)).toBe(true);
    await setTimes(id, now - 46 * MIN, now - 46 * MIN, "queued");
    expect((await reap(testEnv(), now)).failed).toEqual([{ runId: id, reason: "no event for 45 min" }]);
    expect(mockRunpod.terminated).toEqual([pod.id]);
  });

  it("leaves healthy runs alone", async () => {
    const { id, podEnv } = await startedRun();
    await sendEvent(id, podEnv.ZUNOS_EVENTS_TOKEN!, { type: "stage", stage: "setup", status: "running" });
    const report = await reap(testEnv());
    expect(report).toEqual({ failed: [], orphansTerminated: [], podsListed: true });
    expect((await getRow(id)).status).toBe("running");
  });

  it("stops runs longer than MAX_RUN_HOURS", async () => {
    const { id, pod } = await startedRun();
    const now = Date.now();
    await setTimes(id, now - 4.1 * 60 * MIN, now - 1 * MIN);
    const report = await reap(testEnv(), now);
    expect(report.failed).toEqual([{ runId: id, reason: "over 4 h" }]);
    expect(mockRunpod.terminated).toEqual([pod.id]);
  });

  it("stops the newest runs when the hourly total exceeds MAX_HOURLY_USD", async () => {
    const a = await startedRun("tok-alice"); // A40 $0.44
    const b = await startedRun("tok-bob"); // A40 $0.44
    const now = Date.now();
    await setTimes(a.id, now - 20 * MIN, now - MIN);
    await setTimes(b.id, now - 10 * MIN, now - MIN);
    const report = await reap(testEnv({ MAX_HOURLY_USD: "0.5" }), now);
    expect(report.failed).toEqual([{ runId: b.id, reason: "over hourly budget" }]);
    expect(mockRunpod.terminated).toEqual([b.pod.id]);
    expect((await getRow(a.id)).status).toBe("running");
  });

  it("terminates zunos pods without an active run and never touches other pods", async () => {
    const { id, pod } = await startedRun();
    const fake = (podId: string, name: string) =>
      mockRunpod.pods.set(podId, { id: podId, name, status: "RUNNING", costPerHour: 0.3, request: {} as never });
    fake("orphan-1", "zunos-run-00000000-dead-beef-0000-000000000000");
    fake("owner-1", "my-experiment");
    // A finished run whose terminate was missed.
    await env.DB.prepare("UPDATE runs SET status = 'stopped' WHERE id = ?").bind(id).run();

    const report = await reap(testEnv());
    expect(report.orphansTerminated.sort()).toEqual(["orphan-1", pod.id].sort());
    expect(mockRunpod.pods.has("owner-1")).toBe(true);
  });

  it("keeps a pod whose run is claimed but has no pod id yet", async () => {
    const { id, pod } = await startedRun();
    await env.DB.prepare("UPDATE runs SET pod_id = NULL WHERE id = ?").bind(id).run();
    expect((await reap(testEnv())).orphansTerminated).toEqual([]);
    expect(mockRunpod.pods.has(pod.id)).toBe(true);
  });

  it("expires abandoned uploads", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO runs (id, user_id, email, langs, status, created_at) VALUES ('old', 'u-x', 'x', '[]', 'uploading', ?)",
    )
      .bind(now - 4 * 60 * MIN)
      .run();
    expect((await reap(testEnv(), now)).failed).toEqual([{ runId: "old", reason: "upload abandoned" }]);
  });

  it("runs from the scheduled handler", async () => {
    const { id, pod } = await startedRun();
    await setTimes(id, Date.now() - 60 * MIN, Date.now() - 60 * MIN);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(mockRunpod.terminated).toEqual([pod.id]);
    expect((await getRow(id)).status).toBe("failed");
  });
});
