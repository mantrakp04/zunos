// The zunos training backend: `bun src/index.ts`. Listens on PORT (default 3000).
import { join } from "node:path";
import { createApp } from "./app";
import { BlobStore, MAX_BLOB_BYTES } from "./blobs";
import { openDb } from "./db";
import { type Ctx, type Env, envFrom, settings } from "./env";
import { buildPodCode } from "./podcode";
import { REAP_INTERVAL_MS, startReaper } from "./reaper";

export type Started = { ctx: Ctx; port: number; url: string; stop: () => Promise<void> };

/** Opens the database and blob store under DATA_DIR, packs the pod code, starts the reaper and the server. */
export async function start(env: Env = envFrom(process.env), opts: { reapIntervalMs?: number } = {}): Promise<Started> {
  const s = settings(env);
  const db = openDb(join(s.dataDir, "zunos-api.db"));
  const blobs = new BlobStore(join(s.dataDir, "blobs"));
  const ctx: Ctx = { env, db, blobs };

  const missing = (["PUBLIC_URL", "BLOB_SIGNING_SECRET", ...(s.mock ? [] : ["RUNPOD_API_KEY"])] as (keyof Env)[]).filter(
    (k) => !env[k],
  );
  if (missing.length) console.warn(JSON.stringify({ msg: "runs can't start until these are set", missing }));
  if (env.BLOB_SIGNING_SECRET && env.BLOB_SIGNING_SECRET.length < 32)
    console.warn(JSON.stringify({ msg: "BLOB_SIGNING_SECRET is short; use 32+ random characters" }));
  if (!s.allowedEmails.size) console.warn(JSON.stringify({ msg: "ALLOWED_EMAILS is empty: nobody can train" }));

  try {
    await buildPodCode(ctx);
  } catch (e) {
    console.error(JSON.stringify({ msg: "pod code build failed", error: String(e) }));
  }

  const reaper = startReaper(ctx, opts.reapIntervalMs ?? REAP_INTERVAL_MS);
  const app = createApp(ctx).listen({
    hostname: "0.0.0.0",
    port: s.port,
    // Datasets and models are streamed through this server.
    maxRequestBodySize: MAX_BLOB_BYTES + 1024 * 1024,
    idleTimeout: 120,
  });
  const server = app.server!;
  const url = `http://localhost:${server.port}`;
  console.log(JSON.stringify({ msg: "listening", url, dataDir: s.dataDir, publicUrl: s.publicUrl, mock: s.mock }));

  return {
    ctx,
    port: server.port!,
    url,
    async stop() {
      reaper.stop();
      await app.stop();
      db.close();
    },
  };
}

if (import.meta.main) {
  const started = await start();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      console.log(JSON.stringify({ msg: "shutting down", signal }));
      started.stop().finally(() => process.exit(0));
    });
}
