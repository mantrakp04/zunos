import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { costUsd } from "../src/db";
import { mockRunpod } from "../src/runpod";
import { call, getRow, resetState, startedRun, stubFetch } from "./helpers";

beforeEach(async () => {
  await resetState();
});

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
  it("creates a run with a presigned R2 PUT for the dataset", async () => {
    stubFetch();
    const r = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en", "gu"] } });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^[0-9a-f-]{36}$/);
    const url = new URL(r.json.uploadUrl);
    expect(url.origin).toBe("https://acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/zunos-test/runs/${r.json.id}/dataset.tar.gz`);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^AKIDTEST\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    const row = await getRow(r.json.id);
    expect(row).toMatchObject({ user_id: "u-alice", email: "alice@example.com", status: "uploading", langs: '["en","gu"]' });
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

  it("the database enforces one active run per user", async () => {
    const insert = (id: string) =>
      env.DB.prepare("INSERT INTO runs (id, user_id, email, langs, status, created_at) VALUES (?, 'u-x', 'x', '[]', 'queued', 0)")
        .bind(id)
        .run();
    await insert("a");
    await expect(insert("b")).rejects.toThrow(/UNIQUE/);
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
    await env.BUCKET.put(`runs/${json.id}/dataset.tar.gz`, "x");
    const r = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST", env: { PUBLIC_URL: "" } });
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
    const code = new URL(podEnv.ZUNOS_CODE_URL!);
    expect(code.pathname).toBe("/zunos-test/pod/code.tar.gz");
    expect(code.searchParams.get("X-Amz-Expires")).toBe(String(6 * 3600));
    expect(new URL(podEnv.ZUNOS_DATASET_URL!).pathname).toBe(`/zunos-test/runs/${id}/dataset.tar.gz`);
    expect(new URL(podEnv.ZUNOS_MODEL_URL!).pathname).toBe(`/zunos-test/runs/${id}/model.tar`);
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
    await env.BUCKET.put(`runs/${json.id}/dataset.tar.gz`, "x");
    const r = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST" });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("no_capacity");
    expect(await getRow(json.id)).toMatchObject({ status: "uploading", started_at: null, pod_id: null });
  });

  it("re-checks the budget at start and refuses without creating a pod", async () => {
    stubFetch();
    await startedRun("tok-bob"); // $0.44/h in use
    const { json } = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] } });
    await env.BUCKET.put(`runs/${json.id}/dataset.tar.gz`, "x");
    const r = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST", env: { MAX_HOURLY_USD: "0.8" } });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("over_budget");
    expect(mockRunpod.pods.size).toBe(1);
    expect((await getRow(json.id)).status).toBe("uploading");
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
    expect((await call(`/runs/${id}/stop`, { token: "tok-bob", method: "POST" })).status).toBe(404);
    expect((await call(`/runs/${id}`, { token: "tok-alice" })).status).toBe(200);
  });

  it("stop terminates the pod", async () => {
    stubFetch();
    const { id, pod } = await startedRun();
    const r = await call(`/runs/${id}/stop`, { token: "tok-alice", method: "POST" });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("stopped");
    expect(mockRunpod.terminated).toEqual([pod.id]);
    expect((await getRow(id)).finished_at).toBeGreaterThan(0);
    // Idempotent.
    expect((await call(`/runs/${id}/stop`, { token: "tok-alice", method: "POST" })).json.status).toBe("stopped");
    expect(mockRunpod.terminated).toHaveLength(1);
  });

  it("computes cost from price and elapsed hours", async () => {
    stubFetch();
    const { id } = await startedRun();
    const now = Date.now();
    await env.DB.prepare("UPDATE runs SET started_at = ? WHERE id = ?").bind(now - 2 * 3_600_000, id).run();
    const live = (await call(`/runs/${id}`, { token: "tok-alice" })).json.costUsd;
    expect(live).toBeCloseTo(0.88, 3);
    await env.DB.prepare("UPDATE runs SET finished_at = ? WHERE id = ?").bind(now - 1.5 * 3_600_000, id).run();
    expect((await call(`/runs/${id}`, { token: "tok-alice" })).json.costUsd).toBeCloseTo(0.22, 4);

    expect(costUsd({ price_per_hour: 0.5, started_at: 0, finished_at: 90 * 60_000 })).toBe(0.75);
    expect(costUsd({ price_per_hour: null, started_at: 0, finished_at: 1 })).toBe(0);
    expect(costUsd({ price_per_hour: 1, started_at: null, finished_at: null })).toBe(0);
  });
});

describe("bootstrap", () => {
  it("serves pod/bootstrap.sh from R2 without auth", async () => {
    expect((await call("/pod/bootstrap.sh")).status).toBe(404);
    await env.BUCKET.put("pod/bootstrap.sh", "#!/usr/bin/env bash\necho hi\n");
    const r = await call("/pod/bootstrap.sh");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toMatch(/^text\/x-shellscript/);
    expect(r.text).toContain("echo hi");
  });
});
