import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { events } from "./events";
import { ApiError, errorBody } from "./http";
import { keys } from "./r2";
import { reap } from "./reaper";
import { runs } from "./runs";

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

// Public: the pod fetches this first. It contains no secrets.
app.get("/pod/bootstrap.sh", async (c) => {
  const obj = await c.env.BUCKET.get(keys.bootstrap);
  if (!obj) return errorBody(c, 404, "not_found", "bootstrap.sh has not been uploaded.");
  return c.body(await obj.text(), 200, { "Content-Type": "text/x-shellscript; charset=utf-8" });
});

app.route("/", events);
app.route("/", runs);

app.notFound((c) => errorBody(c, 404, "not_found", "Not found."));
app.onError((err, c) => {
  if (err instanceof ApiError) return errorBody(c, err.status, err.code, err.message);
  console.error("unhandled", err);
  return errorBody(c, 500, "internal", "Something went wrong on our side.");
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(reap(env));
  },
} satisfies ExportedHandler<Env>;
