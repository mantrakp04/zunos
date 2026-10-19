import { type Env, type User, settings } from "./env";
import { fail } from "./http";
import { constantTimeEqual, sha256Hex } from "./lifecycle";

const CACHE_MS = 60_000;
const cache = new Map<string, { user: User; expires: number }>();

/** Exposed for tests. */
export const clearAuthCache = () => cache.clear();

async function verify(env: Env, token: string): Promise<User> {
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && hit.expires > now) return hit.user;

  const s = settings(env);
  let res: Response;
  try {
    res = await fetch(`${s.hexclaveUrl}/api/v1/users/me`, {
      headers: {
        "X-Hexclave-Access-Type": "client",
        "X-Hexclave-Project-Id": env.HEXCLAVE_PROJECT_ID ?? "",
        "X-Hexclave-Publishable-Client-Key": env.HEXCLAVE_PUBLISHABLE_CLIENT_KEY ?? "",
        "X-Hexclave-Access-Token": token,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("hexclave verification failed", e);
    return fail(401, "unauthorized", "Could not verify your sign-in. Try again.");
  }
  if (res.status !== 200) fail(401, "unauthorized", "Your sign-in has expired. Sign in again.");

  const body = (await res.json().catch(() => null)) as { id?: unknown; primary_email?: unknown } | null;
  if (!body || typeof body.id !== "string") return fail(401, "unauthorized", "Your sign-in has expired. Sign in again.");
  const user = { id: body.id, email: typeof body.primary_email === "string" ? body.primary_email.toLowerCase() : "" };

  if (cache.size > 1000) for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  cache.set(token, { user, expires: now + CACHE_MS });
  return user;
}

/**
 * The owner's scripts (python/pod/launch.py) send `x-zunos-owner-token: <OWNER_TOKEN>` instead of a Hexclave
 * token; they act as OWNER_EMAIL (which must still be on ALLOWED_EMAILS), with the same budget and limits.
 */
function ownerUser(env: Env, request: Request): User | null {
  const given = request.headers.get("x-zunos-owner-token");
  if (!given) return null;
  if (!env.OWNER_TOKEN || !env.OWNER_EMAIL || !constantTimeEqual(sha256Hex(given), sha256Hex(env.OWNER_TOKEN)))
    return fail(401, "unauthorized", "Bad owner token.");
  return { id: env.OWNER_USER_ID || "owner", email: env.OWNER_EMAIL.toLowerCase() };
}

/** Requires a valid Hexclave access token (or the owner token) whose email is on ALLOWED_EMAILS. */
export async function requireUser(env: Env, request: Request): Promise<User> {
  const owner = ownerUser(env, request);
  if (owner) {
    if (!settings(env).allowedEmails.has(owner.email)) fail(403, "not_allowed", "Training is invite-only for now.");
    return owner;
  }
  const token = request.headers.get("x-stack-access-token");
  if (!token) return fail(401, "unauthorized", "Sign in to train.");
  const user = await verify(env, token);
  if (!user.email || !settings(env).allowedEmails.has(user.email))
    fail(403, "not_allowed", "Training is invite-only for now.");
  return user;
}
