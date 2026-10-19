import { mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "../src/app";
import { clearAuthCache } from "../src/auth";
import { BlobStore } from "../src/blobs";
import { type RunRow, openDb } from "../src/db";
import type { Ctx, Env } from "../src/env";
import { buildPodCode } from "../src/podcode";
import { mockRunpod } from "../src/runpod";

export const USERS: Record<string, { id: string; primary_email: string }> = {
  "tok-alice": { id: "u-alice", primary_email: "Alice@Example.com" },
  "tok-bob": { id: "u-bob", primary_email: "bob@example.com" },
  "tok-eve": { id: "u-eve", primary_email: "eve@elsewhere.com" },
};

/** A throwaway directory, removed when the test process exits. */
export function tempDir(prefix = "zunos-api-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake repo checkout with the pod sources (plus junk that must not be packed). */
export function fakeRepo(): string {
  const repo = tempDir("zunos-repo-");
  const files: Record<string, string> = {
    "python/pod/bootstrap.sh": "#!/usr/bin/env bash\necho hi\n",
    "python/pod/run.py": "print('run')\n",
    "python/pod/__pycache__/run.cpython-311.pyc": "junk",
    "python/core/pyproject.toml": "[project]\nname = 'zunos-core'\n",
    "python/core/src/zunos_core/__init__.py": "",
    "python/core/.venv/bin/python": "junk",
    "python/engine/model.py": "not packed\n",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  return repo;
}

const root = tempDir();
export const REPO_DIR = fakeRepo();

// Test-only values; RUNPOD_MOCK keeps every test away from the real Runpod API.
export const BASE_ENV: Env = {
  HEXCLAVE_PROJECT_ID: "proj_test",
  HEXCLAVE_PUBLISHABLE_CLIENT_KEY: "pck_test",
  HEXCLAVE_API_URL: "https://hexclave.test",
  ALLOWED_EMAILS: "alice@example.com, Bob@Example.com",
  RUNPOD_MOCK: "1",
  RUNPOD_API_KEY: "rp_test_key",
  RUNPOD_API_URL: "https://runpod.test/v2",
  HF_TOKEN: "hf_test",
  PUBLIC_URL: "https://api.zunos.test/",
  BLOB_SIGNING_SECRET: "test-signing-secret-0123456789abcdef", // gitleaks:allow (test fixture)
  DATA_DIR: root,
  REPO_DIR,
};

export const db = openDb(":memory:");
export const blobs = new BlobStore(join(root, "blobs"));
export const ctx: Ctx = { env: BASE_ENV, db, blobs };
export const testCtx = (overrides: Partial<Env> = {}): Ctx => ({ ...ctx, env: { ...BASE_ENV, ...overrides } });

export type Handler = (req: Request) => Response | undefined | Promise<Response | undefined>;

/** Stubs global fetch: Hexclave /users/me answers from USERS; `extra` can handle other hosts. */
export function stubFetch(extra?: Handler) {
  const calls: Request[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: any) => {
    const req: Request = new Request(input, init);
    calls.push(req.clone() as unknown as Request);
    const url = new URL(req.url);
    if (url.host === "hexclave.test" && url.pathname === "/api/v1/users/me") {
      const user = USERS[req.headers.get("x-hexclave-access-token") ?? ""];
      return user ? Response.json(user) : Response.json({ code: "INVALID_ACCESS_TOKEN" }, { status: 401 });
    }
    const res = await extra?.(req);
    if (res) return res;
    throw new Error(`unexpected fetch ${req.method} ${req.url}`);
  }) as typeof fetch);
  return { calls, spy };
}

const apps = new Map<string, App>();
const appFor = (overrides: Partial<Env> = {}) => {
  const k = JSON.stringify(overrides);
  let app = apps.get(k);
  if (!app) apps.set(k, (app = createApp(testCtx(overrides))));
  return app;
};

/** Sends a request to the app. `path` may be a full URL (e.g. a signed blob URL). */
export async function call(
  path: string,
  opts: {
    token?: string;
    method?: string;
    body?: unknown;
    raw?: RequestInit["body"];
    headers?: Record<string, string>;
    env?: Partial<Env>;
  } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers["x-stack-access-token"] = opts.token;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const url = path.startsWith("http") ? path : `https://api.zunos.test${path}`;
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const res = await appFor(opts.env).handle(new Request(url, { method: opts.method ?? "GET", headers, body }));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, status: res.status, json, text };
}

export async function resetState() {
  mock.restore();
  clearAuthCache();
  mockRunpod.reset();
  db.exec("DELETE FROM runs");
  rmSync(blobs.root, { recursive: true, force: true });
  mkdirSync(join(blobs.root, ".tmp"), { recursive: true });
  await buildPodCode(ctx);
}

/** PUTs the dataset like the Mac app does: to the signed URL, Content-Type application/gzip, no auth. */
export const uploadDataset = (uploadUrl: string, body = "fake dataset") =>
  call(uploadUrl, { method: "PUT", raw: body, headers: { "content-type": "application/gzip" } });

/** Creates a run for `token`, uploads a fake dataset, and starts it. Returns the run id and the pod's env. */
export async function startedRun(token = "tok-alice", envOverrides: Partial<Env> = {}) {
  const created = await call("/runs", { token, method: "POST", body: { langs: ["en", "hi"] }, env: envOverrides });
  if (created.status !== 201) throw new Error(`create failed: ${created.text}`);
  const id = created.json.id as string;
  const up = await uploadDataset(created.json.uploadUrl);
  if (up.status !== 200) throw new Error(`upload failed: ${up.text}`);
  const started = await call(`/runs/${id}/start`, { token, method: "POST", env: envOverrides });
  if (started.status !== 200) throw new Error(`start failed: ${started.text}`);
  const row = getRow(id);
  const pod = mockRunpod.pods.get(row.pod_id!)!;
  return { id, row, pod, podEnv: pod.request.env, started: started.json };
}

export const sendEvent = (id: string, token: string, body: unknown) =>
  call(`/runs/${id}/events`, { method: "POST", body, headers: { authorization: `Bearer ${token}` } });

export const getRow = (id: string) => db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id)!;

export const sql = (query: string, ...args: (string | number | null)[]) => db.query(query).run(...args);
