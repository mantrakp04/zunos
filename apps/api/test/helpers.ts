import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { clearAuthCache } from "../src/auth";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { mockRunpod } from "../src/runpod";

export const USERS: Record<string, { id: string; primary_email: string }> = {
  "tok-alice": { id: "u-alice", primary_email: "Alice@Example.com" },
  "tok-bob": { id: "u-bob", primary_email: "bob@example.com" },
  "tok-eve": { id: "u-eve", primary_email: "eve@elsewhere.com" },
};

export type Handler = (req: Request) => Response | undefined | Promise<Response | undefined>;

/** Stubs global fetch: Hexclave /users/me answers from USERS; `extra` can handle other hosts. */
export function stubFetch(extra?: Handler) {
  const calls: Request[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    calls.push(req.clone());
    const url = new URL(req.url);
    if (url.host === "hexclave.test" && url.pathname === "/api/v1/users/me") {
      const user = USERS[req.headers.get("x-hexclave-access-token") ?? ""];
      return user ? Response.json(user) : Response.json({ code: "INVALID_ACCESS_TOKEN" }, { status: 401 });
    }
    const res = await extra?.(req);
    if (res) return res;
    throw new Error(`unexpected fetch ${req.method} ${req.url}`);
  });
  return { calls, spy };
}

export const testEnv = (overrides: Partial<Env> = {}): Env => ({ ...env, ...overrides }) as Env;

export async function call(
  path: string,
  opts: { token?: string; method?: string; body?: unknown; headers?: Record<string, string>; env?: Partial<Env> } = {},
) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers["x-stack-access-token"] = opts.token;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(
    `https://api.zunos.test${path}`,
    { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    testEnv(opts.env),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, status: res.status, json, text };
}

export async function resetState() {
  vi.restoreAllMocks();
  clearAuthCache();
  mockRunpod.reset();
  await env.DB.prepare("DELETE FROM runs").run();
}

/** Creates a run for `token`, uploads a fake dataset, and starts it. Returns the run id and the pod's env. */
export async function startedRun(token = "tok-alice", envOverrides: Partial<Env> = {}) {
  const created = await call("/runs", { token, method: "POST", body: { langs: ["en", "hi"] }, env: envOverrides });
  if (created.status !== 201) throw new Error(`create failed: ${created.text}`);
  const id = created.json.id as string;
  await env.BUCKET.put(`runs/${id}/dataset.tar.gz`, "fake dataset");
  const started = await call(`/runs/${id}/start`, { token, method: "POST", env: envOverrides });
  if (started.status !== 200) throw new Error(`start failed: ${started.text}`);
  const row = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<any>();
  const pod = mockRunpod.pods.get(row.pod_id)!;
  return { id, row, pod, podEnv: pod.request.env, started: started.json };
}

export const sendEvent = (id: string, token: string, body: unknown) =>
  call(`/runs/${id}/events`, { method: "POST", body, headers: { authorization: `Bearer ${token}` } });

export const getRow = (id: string) => env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<any>();
