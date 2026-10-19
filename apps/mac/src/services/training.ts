// Client for the zunos backend (apps/api), which runs training on a GPU pod paid for by the owner.
import { config } from "../config";
import type { Lang, TrainingQuote } from "../shared/types";
import { getAccessToken } from "./auth";

export class TrainingError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.apiUrl) throw new TrainingError("Cloud training isn't set up in this build yet.", "not_configured");
  const token = await getAccessToken();
  if (!token) throw new TrainingError("Sign in to train.", "signed_out");
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-stack-access-token": token, ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new TrainingError(body.error ?? `Training service returned ${res.status}`, body.code);
  return body as T;
}

export type RemoteRun = {
  id: string;
  status: "uploading" | "queued" | "running" | "done" | "failed" | "stopped";
  stage: string | null;
  costUsd: number;
  evals: { step: number; score: number; res: Record<string, unknown> }[];
  steps: { step: number; loss: number }[];
  modelUrl: string | null;
  error: string | null;
};

export const quote = () => api<TrainingQuote>("/quote");

export const createRun = (langs: Lang[]) =>
  api<{ id: string; uploadUrl: string }>("/runs", { method: "POST", body: JSON.stringify({ langs }) });

export const startRun = (id: string) => api<RemoteRun>(`/runs/${id}/start`, { method: "POST" });
export const getRun = (id: string) => api<RemoteRun>(`/runs/${id}`);
export const stopRun = (id: string) => api<RemoteRun>(`/runs/${id}/stop`, { method: "POST" });
