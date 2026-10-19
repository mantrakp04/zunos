import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { BlobStore } from "./blobs";

/** Server configuration, read from the process environment at startup (all values are strings). */
export interface Env {
  HEXCLAVE_PROJECT_ID?: string;
  HEXCLAVE_PUBLISHABLE_CLIENT_KEY?: string;
  HEXCLAVE_API_URL?: string;
  ALLOWED_EMAILS?: string;

  RUNPOD_API_KEY?: string;
  /** Override for tests or a proxy. Defaults to https://api.runpod.io/v2. */
  RUNPOD_API_URL?: string;
  RUNPOD_MOCK?: string;
  HF_TOKEN?: string;

  /** This server's public origin; pods and the Mac app reach it (and its signed blob URLs) here. */
  PUBLIC_URL?: string;
  /** Holds zunos-api.db and blobs/. Defaults to apps/api/data; /data (the persistent volume) in production. */
  DATA_DIR?: string;
  /** HMAC key for signed blob URLs. */
  BLOB_SIGNING_SECRET?: string;
  /** Repository checkout holding python/pod and python/core. Defaults to the repo this file is in. */
  REPO_DIR?: string;
  PORT?: string;

  POD_IMAGE?: string;
  GPU_TYPES?: string;
  MAX_HOURLY_USD?: string;
  MAX_RUN_HOURS?: string;
}

export const ENV_KEYS = [
  "HEXCLAVE_PROJECT_ID",
  "HEXCLAVE_PUBLISHABLE_CLIENT_KEY",
  "HEXCLAVE_API_URL",
  "ALLOWED_EMAILS",
  "RUNPOD_API_KEY",
  "RUNPOD_API_URL",
  "RUNPOD_MOCK",
  "HF_TOKEN",
  "PUBLIC_URL",
  "DATA_DIR",
  "BLOB_SIGNING_SECRET",
  "REPO_DIR",
  "PORT",
  "POD_IMAGE",
  "GPU_TYPES",
  "MAX_HOURLY_USD",
  "MAX_RUN_HOURS",
] as const satisfies readonly (keyof Env)[];

export const envFrom = (source: Record<string, string | undefined>): Env =>
  Object.fromEntries(ENV_KEYS.filter((k) => source[k] !== undefined).map((k) => [k, source[k]])) as Env;

/** Everything a request or the reaper needs. Built once by index.ts; tests build their own. */
export type Ctx = { env: Env; db: Database; blobs: BlobStore };

export type User = { id: string; email: string };

const list = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const positive = (s: string | undefined, fallback: number) => {
  const n = Number(s);
  return s && Number.isFinite(n) && n > 0 ? n : fallback;
};

const port = (s: string | undefined) => {
  const n = Number(s);
  return s && Number.isInteger(n) && n >= 0 && n < 65536 ? n : 3000;
};

const API_DIR = resolve(import.meta.dir, "..");

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
    publicUrl: (env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    dataDir: resolve(env.DATA_DIR || resolve(API_DIR, "data")),
    repoDir: resolve(env.REPO_DIR || resolve(API_DIR, "../..")),
    port: port(env.PORT),
  };
}

export type Settings = ReturnType<typeof settings>;

/** Training jobs need hosts with at least this CUDA driver (the image is cu128). */
export const MIN_CUDA = "12.8";
export const ESTIMATED_HOURS = 1.5;
export const POD_PREFIX = "zunos-run-";
