// Datasets, trained models and the pod code, stored as files under ${DATA_DIR}/blobs. Clients and pods reach
// them with signed URLs: GET|PUT ${PUBLIC_URL}/blobs/<key>?exp=<unix seconds>&sig=<hex HMAC-SHA256>.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Ctx, type Env, settings } from "./env";
import { ApiError, NO_STORE, errorResponse } from "./http";

export const HOUR = 3600;
/** A model.tar is a few GB; anything past this is refused. Bun.serve's maxRequestBodySize must allow it. */
export const MAX_BLOB_BYTES = 6 * 1024 ** 3;

export const keys = {
  code: "pod/code.tar.gz",
  dataset: (runId: string) => `runs/${runId}/dataset.tar.gz`,
  model: (runId: string) => `runs/${runId}/model.tar`,
};

// Segments start with a letter or digit, so "..", "." and the ".tmp" directory can never be named.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const isValidKey = (key: string) => key.length <= 512 && KEY_RE.test(key);

const FLUSH_BYTES = 8 * 1024 * 1024;

export class BlobStore {
  private readonly tmp: string;

  constructor(readonly root: string) {
    this.tmp = join(root, ".tmp");
    mkdirSync(this.tmp, { recursive: true });
  }

  path(key: string): string {
    if (!isValidKey(key)) throw new Error(`invalid blob key ${JSON.stringify(key)}`);
    return join(this.root, key);
  }

  async head(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const s = statSync(this.path(key));
      return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  file(key: string) {
    return Bun.file(this.path(key));
  }

  /**
   * Writes a blob to a temp file, then renames it into place, so readers never see a partial file. Streams are
   * written chunk by chunk and never held in memory. Returns the size written.
   */
  async put(key: string, body: ReadableStream<Uint8Array> | string | Uint8Array, maxBytes = MAX_BLOB_BYTES): Promise<number> {
    const dest = this.path(key);
    const tmp = join(this.tmp, randomUUID());
    try {
      let size: number;
      if (typeof body === "string" || body instanceof Uint8Array) {
        size = await Bun.write(tmp, body);
        if (size > maxBytes) throw new ApiError(413, "too_large", "The file is too large.");
      } else {
        const sink = Bun.file(tmp).writer();
        size = 0;
        let pending = 0;
        try {
          for await (const chunk of body) {
            size += chunk.byteLength;
            if (size > maxBytes) throw new ApiError(413, "too_large", "The file is too large.");
            sink.write(chunk);
            pending += chunk.byteLength;
            if (pending >= FLUSH_BYTES) {
              await sink.flush();
              pending = 0;
            }
          }
        } finally {
          await sink.end();
        }
      }
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(tmp, dest);
      return size;
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  async delete(key: string): Promise<boolean> {
    const p = this.path(key);
    try {
      statSync(p);
    } catch {
      return false;
    }
    rmSync(p, { force: true });
    return true;
  }

  /** Removes temp files left by uploads that died mid-stream. */
  cleanTmp(olderThanMs: number, now = Date.now()): number {
    let removed = 0;
    for (const name of readdirSync(this.tmp)) {
      const p = join(this.tmp, name);
      try {
        if (now - statSync(p).mtimeMs > olderThanMs) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {}
    }
    return removed;
  }
}

// ---- Signed URLs ----

export type BlobMethod = "GET" | "PUT";

export const signature = (secret: string, method: BlobMethod, key: string, exp: string | number) =>
  createHmac("sha256", secret).update(`${method}${key}${exp}`).digest("hex");

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** A URL that allows `method` on `key` until now + expiresSec. Needs PUBLIC_URL and BLOB_SIGNING_SECRET. */
export function presign(env: Env, key: string, method: BlobMethod, expiresSec: number, now = Date.now()): string {
  if (!env.BLOB_SIGNING_SECRET) throw new Error("BLOB_SIGNING_SECRET is not set");
  if (!isValidKey(key)) throw new Error(`invalid blob key ${JSON.stringify(key)}`);
  const exp = Math.floor(now / 1000) + expiresSec;
  const sig = signature(env.BLOB_SIGNING_SECRET, method, key, exp);
  return `${settings(env).publicUrl}/blobs/${encodeKey(key)}?exp=${exp}&sig=${sig}`;
}

export type Verdict = "ok" | "bad_signature" | "expired";

export function verifySignature(
  secret: string,
  method: BlobMethod,
  key: string,
  exp: string | null,
  sig: string | null,
  now = Date.now(),
): Verdict {
  if (!exp || !/^\d{1,12}$/.test(exp) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return "bad_signature";
  const expected = Buffer.from(signature(secret, method, key, exp), "hex");
  if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return "bad_signature";
  return Number(exp) * 1000 < now ? "expired" : "ok";
}

const CONTENT_TYPES: [RegExp, string][] = [
  [/\.tar\.gz$|\.tgz$/, "application/gzip"],
  [/\.tar$/, "application/x-tar"],
];
const contentType = (key: string) => CONTENT_TYPES.find(([re]) => re.test(key))?.[1] ?? "application/octet-stream";

/** Serves GET and PUT /blobs/<key>. No other auth: the signature is the permission. */
export async function handleBlob(ctx: Ctx, request: Request, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  let key: string;
  try {
    key = url.pathname.slice("/blobs/".length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return errorResponse(404, "not_found", "Not found.");
  }
  if (!isValidKey(key)) return errorResponse(404, "not_found", "Not found.");

  const method = request.method === "HEAD" ? "GET" : request.method;
  if (method !== "GET" && method !== "PUT") return errorResponse(405, "method_not_allowed", "Use GET or PUT.");
  const secret = ctx.env.BLOB_SIGNING_SECRET;
  if (!secret) return errorResponse(503, "not_configured", "File storage isn't set up on the server yet.");

  const verdict = verifySignature(secret, method, key, url.searchParams.get("exp"), url.searchParams.get("sig"), now);
  if (verdict === "expired") return errorResponse(403, "expired", "This link has expired.");
  if (verdict !== "ok") return errorResponse(403, "bad_signature", "This link is not valid.");

  if (method === "GET") {
    const head = await ctx.blobs.head(key);
    if (!head) return errorResponse(404, "not_found", "Not found.");
    return new Response(request.method === "HEAD" ? null : ctx.blobs.file(key), {
      headers: { ...NO_STORE, "Content-Type": contentType(key), "Content-Length": String(head.size) },
    });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) return errorResponse(413, "too_large", "The file is too large.");
  if (!request.body) return errorResponse(400, "bad_request", "The upload has no body.");
  try {
    const size = await ctx.blobs.put(key, request.body);
    console.log(JSON.stringify({ msg: "blob stored", key, size }));
    return Response.json({ ok: true, size }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e.status, e.code, e.message);
    console.error(JSON.stringify({ msg: "blob upload failed", key, error: String(e) }));
    return errorResponse(400, "upload_failed", "The upload did not finish.");
  }
}
