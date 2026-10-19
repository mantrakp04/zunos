// The real REST client (RUNPOD_MOCK=0) against a stubbed Runpod, using response shapes from the v2 OpenAPI spec.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { reap } from "../src/reaper";
import { call, getRow, resetState, stubFetch, testEnv } from "./helpers";

const REAL = { RUNPOD_MOCK: "0" } as const;
const problem = (status: number, detail: string) =>
  Response.json({ title: "Error", status, detail }, { status, headers: { "content-type": "application/problem+json" } });

const catalog = {
  gpus: [
    { id: "NVIDIA A40", name: "A40", pool: "AMPERE_48", manufacturer: "NVIDIA", memory: 48, secure: true, community: true, price: { secure: 0.4, community: 0.35 }, maxCount: { secure: 8, community: 4 }, availability: "HIGH" },
    { id: "NVIDIA RTX A6000", name: "RTX A6000", pool: "AMPERE_48", manufacturer: "NVIDIA", memory: 48, secure: true, community: true, price: { secure: 0.49, community: 0.33 }, maxCount: { secure: 8, community: 8 }, availability: "LOW" },
    { id: "NVIDIA L40S", name: "L40S", pool: "ADA_48_PRO", manufacturer: "NVIDIA", memory: 48, secure: true, community: false, price: { secure: 0.86, community: 0 }, maxCount: { secure: 8, community: 0 }, availability: "NONE" },
  ],
};

type Pod = { id: string; name: string; status: string; cost: number };

function fakeRunpod(opts: { pods?: Pod[]; noCapacity?: string[] } = {}) {
  const pods = [...(opts.pods ?? [])];
  const created: any[] = [];
  const deleted: string[] = [];
  const stub = stubFetch(async (req) => {
    const url = new URL(req.url);
    if (url.host !== "runpod.test") return undefined;
    if (req.headers.get("authorization") !== "Bearer rp_test_key") return problem(401, "missing bearer token");
    const path = url.pathname;
    if (req.method === "GET" && path === "/v2/catalog/gpus") return Response.json(catalog);
    if (req.method === "GET" && path === "/v2/pods")
      return Response.json({ pods, pagination: { nextCursor: null, hasNextPage: false } });
    if (req.method === "POST" && path === "/v2/pods") {
      const body = (await req.json()) as any;
      created.push(body);
      if (opts.noCapacity?.includes(body.gpu.id))
        return problem(400, "There are no longer any instances available with the requested specifications.");
      const pod = { id: `pod${created.length}`, name: body.name, status: "PROVISIONING", cost: 0.41 };
      pods.push(pod);
      return Response.json({ ...pod, image: body.image, gpu: { ...body.gpu, vcpuCount: 9, memory: 50 } }, { status: 201 });
    }
    const del = path.match(/^\/v2\/pods\/([^/]+)$/);
    if (req.method === "DELETE" && del) {
      deleted.push(del[1]!);
      const i = pods.findIndex((p) => p.id === del[1]);
      if (i < 0) return problem(404, "pod not found");
      pods.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    return problem(404, `no route ${req.method} ${path}`);
  });
  return { ...stub, pods, created, deleted };
}

beforeEach(resetState);

describe("Runpod REST v2 client", () => {
  it("quotes from the catalog with availability filters", async () => {
    const rp = fakeRunpod();
    const r = await call("/quote", { token: "tok-alice", env: REAL });
    expect(r.json).toEqual({ gpu: "NVIDIA A40", pricePerHour: 0.4, estimatedHours: 1.5, available: true });
    const cat = rp.calls.find((c) => c.url.includes("/catalog/gpus"))!;
    const qs = new URL(cat.url).searchParams;
    expect(Object.fromEntries(qs)).toEqual({ include: "AVAILABILITY", product: "POD", cloud: "SECURE", minCudaVersion: "12.8" });
  });

  it("creates a pod, trying the next GPU type after a 400, and terminates it on stop", async () => {
    const rp = fakeRunpod({ noCapacity: ["NVIDIA A40"] });
    const { json } = await call("/runs", { token: "tok-alice", method: "POST", body: { langs: ["en"] }, env: REAL });
    await env.BUCKET.put(`runs/${json.id}/dataset.tar.gz`, "x");
    const started = await call(`/runs/${json.id}/start`, { token: "tok-alice", method: "POST", env: REAL });
    expect(started.status).toBe(200);

    expect(rp.created.map((b) => b.gpu.id)).toEqual(["NVIDIA A40", "NVIDIA RTX A6000"]); // L40S is out of stock
    const body = rp.created[1];
    expect(Object.keys(body).sort()).toEqual(["cloud", "cmd", "disk", "entrypoint", "env", "gpu", "image", "name", "ports"]);
    expect(body).toMatchObject({ cloud: "SECURE", disk: 150, ports: [], gpu: { id: "NVIDIA RTX A6000", count: 1, minCudaVersion: "12.8" } });
    // The pod's own `cost` wins over the catalog list price.
    expect(await getRow(json.id)).toMatchObject({ pod_id: "pod2", gpu: "NVIDIA RTX A6000", price_per_hour: 0.41 });

    const stopped = await call(`/runs/${json.id}/stop`, { token: "tok-alice", method: "POST", env: REAL });
    expect(stopped.json.status).toBe("stopped");
    expect(rp.deleted).toEqual(["pod2"]);
  });

  it("budget includes every live pod on the account", async () => {
    fakeRunpod({ pods: [{ id: "x", name: "owner-notebook", status: "RUNNING", cost: 1.7 }] });
    const r = await call("/quote", { token: "tok-alice", env: REAL });
    expect(r.json).toMatchObject({ available: false, reason: expect.stringMatching(/spending limit/) });
  });

  it("reports the provider as unavailable when Runpod errors", async () => {
    stubFetch((req) => (new URL(req.url).host === "runpod.test" ? problem(500, "boom") : undefined));
    const r = await call("/quote", { token: "tok-alice", env: REAL });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("provider_unavailable");
  });

  it("reaper sweeps orphaned zunos pods via the API, ignoring other pods and treating 404 as gone", async () => {
    const rp = fakeRunpod({
      pods: [
        { id: "o1", name: "zunos-run-gone", status: "RUNNING", cost: 0.4 },
        { id: "o2", name: "zunos-run-exited", status: "EXITED", cost: 0 },
        { id: "keep", name: "comfyui", status: "RUNNING", cost: 0.3 },
      ],
    });
    const report = await reap(testEnv(REAL));
    expect(report.orphansTerminated.sort()).toEqual(["o1", "o2"]);
    expect(rp.deleted.sort()).toEqual(["o1", "o2"]);
    expect(rp.pods.map((p) => p.id)).toEqual(["keep"]);
  });
});
