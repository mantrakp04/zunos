// HTTP routes. The handlers live in platform-free modules; this file only maps routes onto them.
import { Elysia } from "elysia";
import { handleBlob } from "./blobs";
import type { Ctx } from "./env";
import { handleEvent } from "./events";
import { ApiError, NO_STORE, errorResponse } from "./http";
import { bootstrapPath } from "./podcode";
import { createRun, quote, readRun, startRun, stopRun } from "./runs";

// Every handler reads its own body (or streams it), so Elysia never parses one.
const raw = { parse: "none" } as const;

export function createApp(ctx: Ctx) {
  return (
    new Elysia()
      // Responses built by hand (errors, files) carry NO_STORE themselves. Setting set.headers for those
      // would make Elysia re-wrap them, turning a file body into a chunked stream without Content-Length.
      .onAfterHandle(({ response, set }) => {
        if (!(response instanceof Response)) set.headers["cache-control"] = NO_STORE["Cache-Control"];
      })
      .onError(({ code, error }) => {
        if (error instanceof ApiError) return errorResponse(error.status, error.code, error.message);
        if (code === "NOT_FOUND") return errorResponse(404, "not_found", "Not found.");
        console.error("unhandled", error);
        return errorResponse(500, "internal", "Something went wrong on our side.");
      })

      // Public: the pod fetches this first. It contains no secrets.
      .get("/pod/bootstrap.sh", async () => {
        const file = Bun.file(bootstrapPath(ctx));
        if (!(await file.exists())) return errorResponse(404, "not_found", "bootstrap.sh is not on the server.");
        return new Response(file, { headers: { ...NO_STORE, "Content-Type": "text/x-shellscript; charset=utf-8" } });
      })

      // Signed URLs only (see blobs.ts).
      .get("/blobs/*", ({ request }) => handleBlob(ctx, request), raw)
      .put("/blobs/*", ({ request }) => handleBlob(ctx, request), raw)

      // The pod, with its bearer token.
      .post("/runs/:id/events", ({ request, params }) => handleEvent(ctx, params.id, request), raw)

      // The Mac app, with a Hexclave access token.
      .get("/quote", ({ request }) => quote(ctx, request), raw)
      .post(
        "/runs",
        async ({ request, set }) => {
          const run = await createRun(ctx, request);
          set.status = 201;
          return run;
        },
        raw,
      )
      .get("/runs/:id", ({ request, params }) => readRun(ctx, request, params.id), raw)
      .post("/runs/:id/start", ({ request, params }) => startRun(ctx, request, params.id), raw)
      .post("/runs/:id/stop", ({ request, params }) => stopRun(ctx, request, params.id), raw)
  );
}

export type App = ReturnType<typeof createApp>;
