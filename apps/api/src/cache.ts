// The pod's synthetic-speech cache (python/pod/cache.py): GET|PUT /runs/:id/cache/<name> with the run's events
// token. Names map to cache/<sha256(user id)[:16]>/<name> in the blob store, so a user's later runs (any pod)
// reuse generated and judged speech instead of paying to make it again. The reaper deletes entries nobody has
// written for 30 days.
import { createHash } from "node:crypto";
import { keys } from "./blobs";
import type { Ctx } from "./env";
import { podRun } from "./events";
import { ApiError, NO_STORE, errorResponse } from "./http";

/** <kind>-<16 hex>.tar, as cache.py names them. */
const NAME_RE = /^[a-z]{1,16}-[0-9a-f]{16}\.tar$/;
/** A shard of a few thousand 16 kHz FLAC takes stays well under this. */
const MAX_CACHE_BYTES = 4 * 1024 ** 3;

export const userHash = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 16);

export async function handleCache(ctx: Ctx, request: Request, runId: string, name: string): Promise<Response> {
  try {
    const run = podRun(ctx, runId, request);
    if (!NAME_RE.test(name)) return errorResponse(404, "not_found", "Not found.");
    const key = keys.cache(userHash(run.user_id), name);
    if (request.method === "GET" || request.method === "HEAD") {
      const head = await ctx.blobs.head(key);
      if (!head) return errorResponse(404, "not_found", "Not cached.");
      return new Response(request.method === "HEAD" ? null : ctx.blobs.file(key), {
        headers: { ...NO_STORE, "Content-Type": "application/x-tar", "Content-Length": String(head.size) },
      });
    }
    if (!request.body) return errorResponse(400, "bad_request", "The upload has no body.");
    const size = await ctx.blobs.put(key, request.body, MAX_CACHE_BYTES);
    console.log(JSON.stringify({ msg: "cache stored", runId, key, size }));
    return Response.json({ ok: true, size }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e.status, e.code, e.message);
    console.error(JSON.stringify({ msg: "cache request failed", runId, name, error: String(e) }));
    return errorResponse(400, "upload_failed", "The upload did not finish.");
  }
}
