export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;

  HEXCLAVE_PROJECT_ID: string;
  HEXCLAVE_PUBLISHABLE_CLIENT_KEY: string;
  HEXCLAVE_API_URL?: string;
  ALLOWED_EMAILS?: string;

  RUNPOD_API_KEY?: string;
  /** Override for tests or a proxy. Defaults to https://api.runpod.io/v2. */
  RUNPOD_API_URL?: string;
  RUNPOD_MOCK?: string;
  HF_TOKEN?: string;

  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;

  PUBLIC_URL: string;
  POD_IMAGE?: string;
  GPU_TYPES?: string;
  MAX_HOURLY_USD?: string;
  MAX_RUN_HOURS?: string;
}

export type User = { id: string; email: string };
export type AppEnv = { Bindings: Env; Variables: { user: User } };

const list = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const positive = (s: string | undefined, fallback: number) => {
  const n = Number(s);
  return s && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function settings(env: Env) {
  const gpuTypes = list(env.GPU_TYPES);
  return {
    hexclaveUrl: (env.HEXCLAVE_API_URL || "https://api.hexclave.com").replace(/\/+$/, ""),
    allowedEmails: new Set(list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase())),
    runpodUrl: (env.RUNPOD_API_URL || "https://api.runpod.io/v2").replace(/\/+$/, ""),
    mock: env.RUNPOD_MOCK === "1",
    podImage: env.POD_IMAGE || "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
    gpuTypes: gpuTypes.length ? gpuTypes : ["NVIDIA A40", "NVIDIA RTX A6000", "NVIDIA L40S"],
    maxHourlyUsd: positive(env.MAX_HOURLY_USD, 2),
    maxRunHours: positive(env.MAX_RUN_HOURS, 4),
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
  };
}

export type Settings = ReturnType<typeof settings>;

/** Training jobs need hosts with at least this CUDA driver (the image is cu128). */
export const MIN_CUDA = "12.8";
export const ESTIMATED_HOURS = 1.5;
export const POD_PREFIX = "zunos-run-";
