import { beforeEach, describe, expect, it } from "bun:test";
import { UnknownCostError, committedHourly } from "../src/budget";
import { mockRunpod } from "../src/runpod";
import { call, getRow, resetState, sendEvent, startedRun, stubFetch, uploadDataset } from "./helpers";

beforeEach(async () => {
  await resetState();
  stubFetch();
});

const cacheCall = (url: string, token: string, method = "GET", raw?: string) =>
  call(url, { method, raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/x-tar" } });

describe("synthetic-speech cache", () => {
  it("stores per user, shared by that user's later runs, and needs the pod token", async () => {
    const a = await startedRun("tok-alice");
    const url = `${a.podEnv.ZUNOS_CACHE_URL}/synth-0123456789abcdef.tar`;
    expect((await cacheCall(url, a.podEnv.ZUNOS_EVENTS_TOKEN!)).status).toBe(404);
    expect((await cacheCall(url, a.podEnv.ZUNOS_EVENTS_TOKEN!, "PUT", "tar bytes")).status).toBe(200);
    expect((await cacheCall(url, a.podEnv.ZUNOS_EVENTS_TOKEN!)).text).toBe("tar bytes");
    expect((await cacheCall(url, "0".repeat(64))).status).toBe(401);
    // Bob's run can't read Alice's entry.
    const b = await startedRun("tok-bob");
    const bobUrl = `${b.podEnv.ZUNOS_CACHE_URL}/synth-0123456789abcdef.tar`;
    expect((await cacheCall(bobUrl, b.podEnv.ZUNOS_EVENTS_TOKEN!)).status).toBe(404);
    // Names outside cache.py's scheme are refused.
    const bad = `${a.podEnv.ZUNOS_CACHE_URL}/..%2Fmodel.tar`;
    expect((await cacheCall(bad, a.podEnv.ZUNOS_EVENTS_TOKEN!, "PUT", "x")).status).toBe(404);
  });
});

describe("experiment runs", () => {
  it("keeps the pod's final report and returns it with the logs", async () => {
    const { id, podEnv } = await startedRun();
    const token = podEnv.ZUNOS_EVENTS_TOKEN!;
    const report = { experiment: "s1", variants: [{ name: "whisper-full", test: { avg: 0.1 } }] };
    expect((await sendEvent(id, token, { type: "report", report })).status).toBe(200);
    expect((await sendEvent(id, token, { type: "report", report: "nope" })).status).toBe(400);
    const r = await call(`/runs/${id}`, { token: "tok-alice" });
    expect(r.json.report).toEqual(report);
  });

  it("accepts any app language and a CUDA 13 floor for Higgs experiments", async () => {
    const r = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["ta", "ja"], minCuda: "13.0" } });
    expect(r.status).toBe(201);
    expect(getRow(r.json.id).min_cuda).toBe("13.0");
    await uploadDataset(r.json.uploadUrl);
    expect((await call(`/runs/${r.json.id}/start`, { token: "tok-alice", method: "POST" })).status).toBe(200);
    const pod = mockRunpod.pods.get(getRow(r.json.id).pod_id!)!;
    expect(pod.request.gpu.minCudaVersion).toBe("13.0");
    expect(pod.request.env.ZUNOS_PRICE_PER_HOUR).toBe("0.59");
    const bad = await call("/runs", { token: "tok-bob", method: "POST", body: { langs: ["en"], minCuda: "11.0" } });
    expect(bad.status).toBe(400);
  });

  it("lets the owner's scripts in with OWNER_TOKEN", async () => {
    const env = { OWNER_TOKEN: "owner-secret", OWNER_EMAIL: "alice@example.com", OWNER_USER_ID: "u-alice" };
    const ok = await call("/quote", { headers: { "x-zunos-owner-token": "owner-secret" }, env });
    expect(ok.status).toBe(200);
    const bad = await call("/quote", { headers: { "x-zunos-owner-token": "wrong" }, env });
    expect(bad.status).toBe(401);
  });
});

describe("budget", () => {
  it("defaults to $5/hour", async () => {
    mockRunpod.offers = mockRunpod.offers.map((o) => (o.id === "NVIDIA A40" ? { ...o, pricePerHour: 4.9 } : o));
    expect((await call("/quote", { token: "tok-alice" })).json).toMatchObject({ gpu: "NVIDIA A40", available: true });
  });

  it("fails closed when a live pod's cost is unknown", async () => {
    expect(() => committedHourly([{ id: "p1", name: "other", status: "RUNNING", costPerHour: null }], [])).toThrow(UnknownCostError);
    // An exited pod costs nothing, known or not.
    expect(committedHourly([{ id: "p1", name: "other", status: "EXITED", costPerHour: null }], [])).toBe(0);
    mockRunpod.pods.set("x", { id: "x", name: "other", status: "RUNNING", costPerHour: null, request: {} as never });
    const r = await call("/quote", { token: "tok-alice" });
    expect(r.status).toBe(503);
  });
});
