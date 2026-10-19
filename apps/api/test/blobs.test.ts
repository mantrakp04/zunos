import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BlobStore, handleBlob, presign, signature, verifySignature } from "../src/blobs";
import { type Started, start } from "../src/index";
import { BASE_ENV, REPO_DIR, blobs, call, resetState, tempDir, testCtx } from "./helpers";

const SECRET = BASE_ENV.BLOB_SIGNING_SECRET!;
const KEY = "runs/11111111-2222-3333-4444-555555555555/model.tar";

beforeEach(resetState);

const put = (url: string, body: RequestInit["body"] = "hello") =>
  call(url, { method: "PUT", raw: body, headers: { "content-type": "application/x-tar" } });

describe("signed blob URLs", () => {
  it("signs method + key + exp with HMAC-SHA256 under PUBLIC_URL/blobs", () => {
    const now = 1_800_000_000_000;
    const url = new URL(presign(BASE_ENV, KEY, "PUT", 3600, now));
    expect(url.origin + url.pathname).toBe(`https://api.zunos.test/blobs/${KEY}`);
    expect(url.searchParams.get("exp")).toBe(String(1_800_000_000 + 3600));
    const hmac = createHmac("sha256", SECRET).update(`PUT${KEY}1800003600`).digest("hex");
    expect(url.searchParams.get("sig")).toBe(hmac);
    expect(signature(SECRET, "PUT", KEY, 1_800_003_600)).toBe(hmac);
    expect(verifySignature(SECRET, "PUT", KEY, url.searchParams.get("exp"), url.searchParams.get("sig"), now)).toBe("ok");
  });

  it("a valid PUT stores the body and a valid GET returns it", async () => {
    const up = await put(presign(BASE_ENV, KEY, "PUT", 60), "model bytes");
    expect(up.status).toBe(200);
    expect(up.json).toEqual({ ok: true, size: 11 });
    const down = await call(presign(BASE_ENV, KEY, "GET", 60));
    expect(down.status).toBe(200);
    expect(down.text).toBe("model bytes");
    expect(down.res.headers.get("content-type")).toBe("application/x-tar");
    expect(down.res.headers.get("content-length")).toBe("11");
    expect(down.res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("a PUT replaces the previous file", async () => {
    await put(presign(BASE_ENV, KEY, "PUT", 60), "first");
    await put(presign(BASE_ENV, KEY, "PUT", 60), "second");
    expect((await call(presign(BASE_ENV, KEY, "GET", 60))).text).toBe("second");
  });

  it("refuses an expired URL", async () => {
    const past = Date.now() - 2 * 3600_000;
    const r = await put(presign(BASE_ENV, KEY, "PUT", 3600, past));
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: expect.any(String), code: "expired" });
    expect(await blobs.head(KEY)).toBeNull();
  });

  it("refuses a tampered signature, key or expiry", async () => {
    await blobs.put(KEY, "secret model");
    const good = new URL(presign(BASE_ENV, KEY, "GET", 600));
    const sig = good.searchParams.get("sig")!;

    const flipped = new URL(good);
    flipped.searchParams.set("sig", (sig[0] === "a" ? "b" : "a") + sig.slice(1));
    const otherKey = new URL(good);
    otherKey.pathname = "/blobs/runs/99999999-2222-3333-4444-555555555555/model.tar";
    const laterExp = new URL(good);
    laterExp.searchParams.set("exp", String(Number(good.searchParams.get("exp")) + 86_400));
    const noSig = new URL(good);
    noSig.searchParams.delete("sig");
    const shortSig = new URL(good);
    shortSig.searchParams.set("sig", sig.slice(0, 32));
    const otherSecret = new URL(presign({ ...BASE_ENV, BLOB_SIGNING_SECRET: "another-secret-entirely-xxxxxxxxxxx" }, KEY, "GET", 600));

    for (const url of [flipped, otherKey, laterExp, noSig, shortSig, otherSecret]) {
      const r = await call(url.toString());
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("bad_signature");
    }
    expect((await call(good.toString())).text).toBe("secret model");
  });

  it("refuses a URL used with the wrong method", async () => {
    await blobs.put(KEY, "secret model");
    const getAsPut = await put(presign(BASE_ENV, KEY, "GET", 600), "overwrite");
    expect(getAsPut.status).toBe(403);
    expect(getAsPut.json.code).toBe("bad_signature");
    const putAsGet = await call(presign(BASE_ENV, KEY, "PUT", 600));
    expect(putAsGet.status).toBe(403);
    expect(putAsGet.json.code).toBe("bad_signature");
    expect(await blobs.file(KEY).text()).toBe("secret model");

    const del = await call(presign(BASE_ENV, KEY, "PUT", 600), { method: "DELETE" });
    expect(del.status).toBe(404); // no such route
  });

  it("404s a missing blob and a key that tries to leave the store", async () => {
    expect((await call(presign(BASE_ENV, KEY, "GET", 60))).status).toBe(404);
    const exp = Math.floor(Date.now() / 1000) + 60;
    for (const key of ["../zunos-api.db", "runs/../../x", ".tmp/abc"]) {
      const url = `https://api.zunos.test/blobs/${key}?exp=${exp}&sig=${signature(SECRET, "GET", key, exp)}`;
      expect((await call(url)).status).toBe(404);
    }
    expect(() => presign(BASE_ENV, "../x", "GET", 60)).toThrow();
  });

  it("refuses everything when BLOB_SIGNING_SECRET is not set", async () => {
    const url = presign(BASE_ENV, KEY, "PUT", 60);
    const r = await call(url, { method: "PUT", raw: "x", env: { BLOB_SIGNING_SECRET: "" } });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("not_configured");
  });

  it("HEAD reports the size without a body", async () => {
    await blobs.put(KEY, "12345");
    const res = await handleBlob(testCtx(), new Request(presign(BASE_ENV, KEY, "GET", 60), { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe("");
  });
});

describe("blob store", () => {
  it("never leaves a partial file when an upload dies mid-stream", async () => {
    const store = new BlobStore(join(tempDir(), "blobs"));
    await store.put(KEY, "old version");
    let sent = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 3) c.enqueue(new Uint8Array(1024).fill(1));
        else c.error(new Error("connection reset"));
      },
    });
    await expect(store.put(KEY, broken)).rejects.toThrow("connection reset");
    expect(await store.file(KEY).text()).toBe("old version");
    expect(readdirSync(join(store.root, ".tmp"))).toEqual([]);
  });

  it("refuses bodies over the size limit and cleans up", async () => {
    const store = new BlobStore(join(tempDir(), "blobs"));
    const big = new Blob([new Uint8Array(4096)]).stream();
    await expect(store.put(KEY, big, 1000)).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(await store.head(KEY)).toBeNull();
    expect(readdirSync(join(store.root, ".tmp"))).toEqual([]);
  });
});

describe("startup", () => {
  let server: Started;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = tempDir();
    server = await start({ ...BASE_ENV, DATA_DIR: dataDir, PORT: "0", PUBLIC_URL: "" }, { reapIntervalMs: 3_600_000 });
  });
  afterAll(async () => {
    await server.stop();
  });

  it("migrates the database file in WAL mode and packs the pod code at startup", async () => {
    expect(existsSync(join(dataDir, "zunos-api.db"))).toBe(true);
    expect(server.ctx.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(server.ctx.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });

    const listing = Bun.spawnSync(["tar", "tzf", join(dataDir, "blobs/pod/code.tar.gz")]).stdout.toString().trim().split("\n");
    expect(listing).toContain("python/pod/run.py");
    expect(listing).toContain("python/pod/bootstrap.sh");
    expect(listing).toContain("python/core/pyproject.toml");
    expect(listing.filter((p) => /__pycache__|\.venv|engine/.test(p))).toEqual([]);

    const boot = await fetch(`${server.url}/pod/bootstrap.sh`);
    expect(boot.status).toBe(200);
    expect(await boot.text()).toBe(await Bun.file(join(REPO_DIR, "python/pod/bootstrap.sh")).text());
  });
});

/** The real server in its own process, so its memory can be measured apart from the test's client. */
async function spawnServer(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: { ...process.env, ...env, PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes('"msg":"listening"')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const url = JSON.parse(out.split("\n").find((l) => l.includes('"msg":"listening"'))!).url as string;
  const rssBytes = async () => Number(await new Response(Bun.spawn(["ps", "-o", "rss=", "-p", String(proc.pid)]).stdout).text()) * 1024;
  return { proc, url, rssBytes };
}

describe("streaming through the server process", () => {
  it("streams a large PUT to disk and a GET back out without buffering it in memory", async () => {
    const dataDir = tempDir();
    const env = { ...BASE_ENV, DATA_DIR: dataDir } as Record<string, string>;
    const server = await spawnServer(env);
    const urlFor = (method: "GET" | "PUT") => presign({ ...BASE_ENV, PUBLIC_URL: server.url }, KEY, method, 600);
    const CHUNK = 1024 * 1024;
    const TOTAL = 400; // MiB: well over Bun's default 128 MiB request limit
    try {
      const baseline = await server.rssBytes();
      let peak = baseline;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          peak = Math.max(peak, await server.rssBytes());
          await Bun.sleep(20);
        }
      })();

      const chunk = new Uint8Array(CHUNK);
      const sent = createHash("sha256");
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i === TOTAL) return c.close();
          chunk.fill(i++ % 251);
          sent.update(chunk);
          c.enqueue(chunk.slice());
        },
      });
      const up = await fetch(urlFor("PUT"), { method: "PUT", body, headers: { "content-type": "application/x-tar" } });
      expect(up.status).toBe(200);
      expect(await up.json()).toEqual({ ok: true, size: TOTAL * CHUNK });

      const down = await fetch(urlFor("GET"));
      expect(down.status).toBe(200);
      expect(down.headers.get("content-length")).toBe(String(TOTAL * CHUNK));
      const received = createHash("sha256");
      for await (const part of down.body!) received.update(part);
      expect(received.digest("hex")).toBe(sent.digest("hex"));

      sampling = false;
      await sampler;
      // Buffering the body anywhere in the server would add ~400 MiB.
      expect(peak - baseline).toBeLessThan(100 * CHUNK);
      expect(readdirSync(join(dataDir, "blobs/.tmp"))).toEqual([]);
    } finally {
      server.proc.kill();
      await server.proc.exited;
    }
  }, 60_000);
});
