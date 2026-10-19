import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const fail = (status: ContentfulStatusCode, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};

export const errorBody = (c: Context, status: ContentfulStatusCode, code: string, error: string) =>
  c.json({ error, code }, status);

export async function readJson(c: Context, maxBytes = 64 * 1024): Promise<unknown> {
  const text = await c.req.text();
  if (text.length > maxBytes) fail(413, "too_large", "Request body is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return fail(400, "bad_request", "Request body must be JSON.");
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
