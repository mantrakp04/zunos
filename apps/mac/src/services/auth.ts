// Hexclave sign-in over its REST API (there is no React Native SDK): an emailed 6-digit code,
// entered in the app. The refresh token lives in the macOS Keychain; the access token only in memory.
import Native from "../../modules/zunos-native";
import { config } from "../config";
import type { User } from "../shared/types";

const REFRESH_KEY = "hexclave.refresh_token";
const { apiUrl, projectId, publishableClientKey, otpCallbackUrl } = config.hexclave;

let accessToken: { token: string; expiresAt: number } | null = null;

export class AuthError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  if (!projectId) throw new AuthError("Hexclave is not configured. Start the app with `bun run start`.", "not_configured");
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Hexclave-Access-Type": "client",
      "X-Hexclave-Project-Id": projectId,
      ...(publishableClientKey ? { "X-Hexclave-Publishable-Client-Key": publishableClientKey } : {}),
      ...(init.token ? { "X-Hexclave-Access-Token": init.token } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(body.error ?? `Hexclave returned ${res.status}`, body.code);
  return body as T;
}

function jwtExpiry(token: string) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp * 1000;
  } catch {
    return Date.now() + 5 * 60_000;
  }
}

function store(tokens: { access_token: string; refresh_token?: string }) {
  accessToken = { token: tokens.access_token, expiresAt: jwtExpiry(tokens.access_token) };
  if (tokens.refresh_token) Native.keychainSet(REFRESH_KEY, tokens.refresh_token);
}

/** Step 1: email a sign-in code. Returns the nonce that must accompany the code. */
export async function sendCode(email: string) {
  const { nonce } = await request<{ nonce: string }>("/auth/otp/send-sign-in-code", {
    method: "POST",
    body: JSON.stringify({ email, callback_url: otpCallbackUrl }),
  });
  return nonce;
}

/** Step 2: the code the user typed followed by the nonce. Signs up new emails automatically. */
export async function verifyCode(code: string, nonce: string) {
  const tokens = await request<{ access_token: string; refresh_token: string; is_new_user: boolean }>("/auth/otp/sign-in", {
    method: "POST",
    body: JSON.stringify({ code: code.trim() + nonce }),
  });
  store(tokens);
  return currentUser();
}

/** A valid access token, refreshed from the Keychain when needed; null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  if (accessToken && accessToken.expiresAt - Date.now() > 30_000) return accessToken.token;
  const refresh = Native.keychainGet(REFRESH_KEY);
  if (!refresh) return null;
  const res = await fetch(`${apiUrl}/api/v1/auth/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: projectId,
      client_secret: publishableClientKey,
    }).toString(),
  });
  if (res.status === 400 || res.status === 401) {
    // Refresh token revoked or expired: the user has to sign in again.
    Native.keychainDelete(REFRESH_KEY);
    accessToken = null;
    return null;
  }
  if (!res.ok) throw new AuthError(`Could not refresh the session (${res.status})`);
  store(await res.json());
  return accessToken!.token;
}

export async function currentUser(): Promise<User | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const u = await request<{ id: string; primary_email: string | null; display_name: string | null }>("/users/me", { token });
  return { id: u.id, email: u.primary_email, name: u.display_name };
}

export async function signOut() {
  const token = await getAccessToken().catch(() => null);
  if (token) await request("/auth/sessions/current", { method: "DELETE", token, body: "{}" }).catch(() => {});
  Native.keychainDelete(REFRESH_KEY);
  accessToken = null;
}
