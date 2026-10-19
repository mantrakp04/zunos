export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};

/** Every response, errors included, is private and never cached. */
export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export const errorResponse = (status: number, code: string, error: string) =>
  Response.json({ error, code }, { status, headers: NO_STORE });

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) fail(413, "too_large", "Request body is too large.");
  const text = await request.text();
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
