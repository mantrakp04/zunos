import { beforeEach, describe, expect, it } from "bun:test";
import { costUsd } from "../src/db";
import { mockRunpod } from "../src/runpod";
import { signature } from "../src/blobs";
import { BASE_ENV, blobs, call, getRow, resetState, sql, startedRun, stubFetch, uploadDataset } from "./helpers";

beforeEach(async () => {
  await resetState();
});

/** Checks a signed blob URL: right origin, path, method and expiry, with a valid signature. */
function expectSigned(url: string, key: string, method: "GET" | "PUT", ttlSec: number) {
  const u = new URL(url);
  expect(u.origin).toBe("https://api.zunos.test");
  expect(u.pathname).toBe(`/blobs/${key}`);
  const exp = Number(u.searchParams.get("exp"));
  expect(Math.abs(exp - (Date.now() / 1000 + ttlSec))).toBeLessThan(5);
  expect(u.searchParams.get("sig")).toBe(signature(BASE_ENV.BLOB_SIGNING_SECRET!, method, key, exp));
}

describe("auth", () => {
  it("rejects a missing token", async () => {
    stubFetch();
    const r = await call("/quote");
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: expect.any(String), code: "unauthorized" });
    expect(r.res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects a token Hexclave doesn't accept", async () => {
    stubFetch();
    const r = await call("/runs", { token: "tok-bogus", method: "POST", body: { langs: ["en"] } });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("unauthorized");
  });

  it("sends the Hexclave client headers and caches the result for 60 s", async () => {
    const { calls } = stubFetch();
    expect((await call("/quote", { token: "tok-alice" })).status).toBe(200);
    expect((await call("/quote", { token: "tok-alice" })).status).toBe(200);
    const hex = calls.filter((r) => r.url.startsWith("https://hexclave.test/"));
    expect(hex).toHaveLength(1);
    expect(hex[0]!.url).toBe("https://hexclave.test/api/v1/users/me");
    expect(Object.fromEntries(hex[0]!.headers)).toMatchObject({
      "x-hexclave-access-type": "client",
      "x-hexclave-project-id": "proj_test",
      "x-hexclave-publishable-client-key": "pck_test",
      "x-hexclave-access-token": "tok-alice",
    });
  });

  it("refuses signed-in users who are not on the allowlist", async () => {
    stubFetch();
    const r = await call("/quote", { token: "tok-eve" });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "Training is invite-only for now.", code: "not_allowed" });
  });

  it("matches the allowlist case-insensitively", async () => {
    stubFetch();
    expect((await call("/quote", { token: "tok-bob" })).status).toBe(200);
  });

  it("errors are JSON with a code, including 404", async () => {
    const r = await call("/nope");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: expect.any(String), code: "not_found" });
    expect(r.res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("successful responses are private, no-store too", async () => {
    stubFetch();
    const r = await call("/quote", { token: "tok-alice" });
    expect(r.res.headers.get("cache-control")).toBe("private, no-store");
    expect(r.res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("rejects a body that isn't JSON", async () => {
    stubFetch();
    const r = await call("/runs", { token: "tok-alice", method: "POST", raw: "{nope", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("bad_request");
  });
});

describe("quote", () => {
  it("picks the first configured GPU that is in stock and in budget", async () => {
    stubFetch();
    const r = await call("/quote", { token: "tok-alice" });
    expect(r.json).toEqual({ gpu: "NVIDIA A40", pricePerHour: 0.44, estimatedHours: 1.5, available: true });
  });

  it("skips out-of-stock types", async () => {
    stubFetch();
    mockRunpod.offers[0]!.inStock = false;
    const r = await call("/quote", { token: "tok-alice" });
    expect(r.json).toMatchObject({ gpu: "NVIDIA RTX A6000", pricePerHour: 0.49, available: true });
  });

  it("refuses when nothing fits the remaining budget", async () => {
    stubFetch();
    const r = await call("/quote", { token: "tok-alice", env: { MAX_HOURLY_USD: "0.4" } });
    expect(r.json).toMatchObject({ gpu: "NVIDIA A40", available: false, reason: expect.stringMatching(/spending limit/) });
  });

  it("counts running pods (including non-zunos pods) against the budget", async () => {
    stubFetch();
    await startedRun("tok-bob"); // A40 at $0.44/h
    mockRunpod.pods.set("owner-pod", {
      id: "owner-pod",
      name: "owners-own-pod",
      status: "RUNNING",
      costPerHour: 0.9,
      request: {} as never,
    });
    // $2 - 0.44 - 0.90 = $0.66 left: A40 still fits.
    expect((await call("/quote", { token: "tok-alice" })).json).toMatchObject({ gpu: "NVIDIA A40", available: true });
    // $1.5 - 1.34 = $0.16 left: nothing fits.
    const r = await call("/quote", { token: "tok-alice", env: { MAX_HOURLY_USD: "1.5" } });
    expect(r.json.available).toBe(false);
  });

  it("is unavailable while the user has an active run", async () => {
    stubFetch();
    await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    const r = await call("/quote", { token: "tok-alice" });
    expect(r.json).toMatchObject({ available: false, reason: "You already have a training run in progress." });
  });
});

describe("runs", () => {
  it("creates a run with a signed PUT URL for the dataset", async () => {
    stubFetch();
    const r = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en", "gu"] } });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^[0-9a-f-]{36}$/);
    expectSigned(r.json.uploadUrl, `runs/${r.json.id}/dataset.tar.gz`, "PUT", 3600);

    const row = getRow(r.json.id);
    expect(row).toMatchObject({ user_id: "u-alice", email: "alice@example.com", status: "uploading", langs: '["en","gu"]' });
  });

  it("accepts the dataset the way the Mac app uploads it", async () => {
    stubFetch();
    const { json } = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    const up = await uploadDataset(json.uploadUrl, "gzip bytes");
    expect(up.status).toBe(200);
    expect(await Bun.file(`${BASE_ENV.DATA_DIR}/blobs/runs/${json.id}/dataset.tar.gz`).text()).toBe("gzip bytes");
  });

  it("won't create a run when blob URLs can't be signed", async () => {
    stubFetch();
    for (const env of [{ PUBLIC_URL: "" }, { BLOB_SIGNING_SECRET: "" }]) {
      const r = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] }, env });
      expect(r.status).toBe(503);
      expect(r.json.code).toBe("not_configured");
    }
  });

  it("validates langs", async () => {
    stubFetch();
    for (const body of [{}, { langs: [] }, { langs: ["fr"] }, { langs: "en" }]) {
      const r = await call("/runs", { token: "tok-alice", method: "POST", body });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe("bad_request");
    }
  });

  it("allows one active run per user", async () => {
    stubFetch();
    expect((await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } })).status).toBe(201);
    const r = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("run_active");
    // Another user is unaffected.
    expect((await call("/runs", { token: "tok-bob", method: "POST", body: { langs: ["en"] } })).status).toBe(201);
  });

  it("the database enforces one active run per user", () => {
    const insert = (id: string) =>
      sql("INSERT INTO runs (id, user_id, email, langs, status, created_at) VALUES (?, 'u-x', 'x', '[]', 'queued', 0)", id);
    insert("a");
    expect(() => insert("b")).toThrow(/UNIQUE/);
  });

  it("won't start before the dataset is uploaded", async () => {
    stubFetch();
    const { json } = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    const r = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("dataset_missing");
    expect(mockRunpod.pods.size).toBe(0);
  });

  it("won't launch a pod when the server isn't configured", async () => {
    stubFetch();
    const { json } = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    await uploadDataset(json.uploadUrl, "x");
    for (const env of [{ PUBLIC_URL: "" }, { BLOB_SIGNING_SECRET: "" }, { RUNPOD_MOCK: "0", RUNPOD_API_KEY: "" }]) {
      const r = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST", env });
      expect(r.status).toBe(503);
      expect(r.json.code).toBe("not_configured");
    }
    expect(mockRunpod.pods.size).toBe(0);
    expect(getRow(json.id).status).toBe("uploading");
  });

  it("won't launch a pod when the pod code hasn't been built", async () => {
    stubFetch();
    const { json } = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    await uploadDataset(json.uploadUrl, "x");
    await blobs.delete("pod/code.tar.gz");
    const r = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST" });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("not_configured");
    expect(mockRunpod.pods.size).toBe(0);
  });

  it("starts a pod (RUNPOD_MOCK=1) with the right request and env", async () => {
    stubFetch();
    const { id, row, pod, podEnv, started } = await startedRun();
    expect(started).toEqual({ id, status: "queued", stage: null, costUsd: expect.any(Number), evals: [], steps: [], modelUrl: null, error: null });
    expect(row).toMatchObject({ status: "queued", gpu: "NVIDIA A40", price_per_hour: 0.44, pod_id: pod.id });
    expect(row.started_at).toBeGreaterThan(0);
    expect(row.events_token_hash).toMatch(/^[0-9a-f]{64}$/);

    const { env: _e, ...req } = pod.request;
    expect(req).toEqual({
      name: `zunos-run-${id}`,
      cloud: "SECURE",
      image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
      gpu: { id: "NVIDIA A40", count: 1, minCudaVersion: "12.8" },
      disk: 150,
      ports: [],
      entrypoint: ["bash", "-c"],
      cmd: ['curl -fsSL "$ZUNOS_BOOTSTRAP_URL" | bash'],
    });
    expect(Object.keys(podEnv).sort()).toEqual(
      ["HF_TOKEN", "ZUNOS_BOOTSTRAP_URL", "ZUNOS_CODE_URL", "ZUNOS_DATASET_URL", "ZUNOS_EVENTS_TOKEN", "ZUNOS_EVENTS_URL", "ZUNOS_MODEL_URL", "ZUNOS_RUN_ID"].sort(),
    );
    expect(podEnv.ZUNOS_RUN_ID).toBe(id);
    expect(podEnv.ZUNOS_BOOTSTRAP_URL).toBe("https://api.zunos.test/pod/bootstrap.sh");
    expect(podEnv.ZUNOS_EVENTS_URL).toBe(`https://api.zunos.test/runs/${id}/events`);
    expect(podEnv.ZUNOS_EVENTS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(podEnv.HF_TOKEN).toBe("hf_test");
    expectSigned(podEnv.ZUNOS_CODE_URL!, "pod/code.tar.gz", "GET", 6 * 3600);
    expectSigned(podEnv.ZUNOS_DATASET_URL!, `runs/${id}/dataset.tar.gz`, "GET", 6 * 3600);
    expectSigned(podEnv.ZUNOS_MODEL_URL!, `runs/${id}/model.tar`, "PUT", 6 * 3600);

    // The pod can fetch what it was given.
    const code = await call(podEnv.ZUNOS_CODE_URL!);
    expect(code.status).toBe(200);
    expect(code.res.headers.get("content-type")).toBe("application/gzip");
    expect((await call(podEnv.ZUNOS_DATASET_URL!)).text).toBe("fake dataset");
  });

  it("omits HF_TOKEN from the pod when it isn't set", async () => {
    stubFetch();
    const { podEnv } = await startedRun("tok-alice", { HF_TOKEN: "" });
    expect(podEnv.HF_TOKEN).toBeUndefined();
  });

  it("falls through GPU types on capacity errors", async () => {
    stubFetch();
    mockRunpod.noCapacity.add("NVIDIA A40");
    const { row } = await startedRun();
    expect(row.gpu).toBe("NVIDIA RTX A6000");
    expect(row.price_per_hour).toBe(0.49);
  });

  it("releases the run when no GPU type has capacity", async () => {
    stubFetch();
    for (const o of mockRunpod.offers) mockRunpod.noCapacity.add(o.id);
    const { json } = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    await uploadDataset(json.uploadUrl, "x");
    const r = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST" });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("no_capacity");
    expect(getRow(json.id)).toMatchObject({ status: "uploading", started_at: null, pod_id: null });
  });

  it("re-checks the budget at start and refuses without creating a pod", async () => {
    stubFetch();
    await startedRun("tok-bob"); // $0.44/h in use
    const { json } = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    await uploadDataset(json.uploadUrl, "x");
    const r = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST", env: { MAX_HOURLY_USD: "0.8" } });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("over_budget");
    expect(mockRunpod.pods.size).toBe(1);
    expect(getRow(json.id).status).toBe("uploading");
  });

  it("won't start a run twice", async () => {
    stubFetch();
    const { id } = await startedRun();
    const r = await call(`/runs/${id}/start`, { token: "tok-alice", method: "POST" });
    expect(r.status).toBe(409);
    expect(mockRunpod.pods.size).toBe(1);
  });

  it("only the owner can read, start or stop a run", async () => {
    stubFetch();
    const { id } = await startedRun();
    expect((await call(`/runs/${id}`, { token: "tok-bob" })).status).toBe(404);
    expect((await call(`/runs/${id}/start`, { token: "tok-bob", method: "POST" })).status).toBe(404);
    expect((await call(`/runs/${id}/stop`, { token: "tok-bob", method: "POST" })).status).toBe(404);
    expect((await call(`/runs/${id}`, { token: "tok-alice" })).status).toBe(200);
  });

  it("stop terminates the pod and deletes the dataset", async () => {
    stubFetch();
    const { id, pod, podEnv } = await startedRun();
    const r = await call(`/runs/${id}/stop`, { token: "tok-alice", method: "POST" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("stopped");
    expect(mockRunpod.terminated).toEqual([pod.id]);
    expect(getRow(id).finished_at).toBeGreaterThan(0);
    expect((await call(podEnv.ZUNOS_DATASET_URL!)).status).toBe(404);
    // Idempotent.
    expect((await call(`/runs/${id}/stop`, { token: "tok-alice", method: "POST" })).json.status).toBe("stopped");
    expect(mockRunpod.terminated).toHaveLength(1);
  });

  it("computes cost from price and elapsed hours", async () => {
    stubFetch();
    const { id } = await startedRun();
    const now = Date.now();
    sql("UPDATE runs SET started_at = ? WHERE id = ?", now - 2 * 3_600_000, id);
    const live = (await call(`/runs/${id}`, { token: "tok-alice" })).json.costUsd;
    expect(live).toBeCloseTo(0.88, 3);
    sql("UPDATE runs SET finished_at = ? WHERE id = ?", now - 1.5 * 3_600_000, id);
    expect((await call(`/runs/${id}`, { token: "tok-alice" })).json.costUsd).toBeCloseTo(0.22, 4);

    expect(costUsd({ price_per_hour: 0.5, started_at: 0, finished_at: 90 * 60_000 })).toBe(0.75);
    expect(costUsd({ price_per_hour: null, started_at: 0, finished_at: 1 })).toBe(0);
    expect(costUsd({ price_per_hour: 1, started_at: null, finished_at: null })).toBe(0);
  });
});

describe("bootstrap", () => {
  it("serves python/pod/bootstrap.sh from the repo without auth", async () => {
    const r = await call("/pod/bootstrap.sh");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toMatch(/^text\/x-shellscript/);
    expect(r.res.headers.get("cache-control")).toBe("private, no-store");
    expect(r.text).toContain("echo hi");
  });

  it("404s when the repo has no bootstrap.sh", async () => {
    const r = await call("/pod/bootstrap.sh", { env: { REPO_DIR: "/nonexistent" } });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("not_found");
  });
});
