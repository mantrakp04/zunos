// Runpod REST v2 (https://docs.runpod.io/api-reference-v2/overview; spec at
// https://docs.runpod.io/api-reference-v2/openapi.json, server https://api.runpod.io, paths under /v2).
import { type Env, MIN_CUDA, settings } from "./env";
import { isObject } from "./http";

export type GpuOffer = {
  id: string;
  /** On-demand Secure Cloud list price for one GPU, USD/hour. */
  pricePerHour: number;
  inStock: boolean;
};

export type PodSummary = { id: string; name: string; status: string; costPerHour: number };

/** Subset of CreatePodRequest that we send. */
export type CreatePodRequest = {
  name: string;
  cloud: "SECURE";
  image: string;
  gpu: { id: string; count: number; minCudaVersion: string };
  disk: number;
  ports: string[];
  env: Record<string, string>;
  entrypoint: string[];
  cmd: string[];
};

export class RunpodError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Runpod ${status}: ${detail}`);
  }
  /**
   * Per the createPod docs: 400 covers both "no capacity" and request-rule violations (no machine-readable
   * code), 403 means this account can't use that pool. Both mean "try the next GPU type".
   */
  get tryNextGpu() {
    return this.status === 400 || this.status === 403;
  }
}

export interface Runpod {
  listGpuOffers(): Promise<GpuOffer[]>;
  createPod(req: CreatePodRequest): Promise<{ id: string; costPerHour: number | null }>;
  terminatePod(id: string): Promise<void>;
  listPods(): Promise<PodSummary[]>;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parsePod(p: unknown): PodSummary | null {
  if (!isObject(p) || typeof p.id !== "string") return null;
  return {
    id: p.id,
    name: typeof p.name === "string" ? p.name : "",
    status: typeof p.status === "string" ? p.status : "UNKNOWN",
    costPerHour: num(p.cost) ?? 0,
  };
}

function restRunpod(env: Env): Runpod {
  const base = settings(env).runpodUrl;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    if (!env.RUNPOD_API_KEY) throw new RunpodError(0, "RUNPOD_API_KEY is not set");
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new RunpodError(0, `network error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      // Errors are application/problem+json {title, status, detail, errors?}.
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text);
        if (isObject(j)) {
          const errs = Array.isArray(j.errors) ? ` (${j.errors.join("; ")})` : "";
          detail = `${j.detail ?? j.title ?? text}${errs}`;
        }
      } catch {}
      throw new RunpodError(res.status, detail);
    }
    return res;
  }

  return {
    async listGpuOffers() {
      // Availability is scoped by cloud, product, and CUDA floor, matching what createPod will ask for.
      const qs = new URLSearchParams({ include: "AVAILABILITY", product: "POD", cloud: "SECURE", minCudaVersion: MIN_CUDA });
      const body = (await (await call("GET", `/catalog/gpus?${qs}`)).json()) as unknown;
      const gpus = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.gpus) ? body.gpus : [];
      const offers: GpuOffer[] = [];
      for (const g of gpus) {
        if (!isObject(g) || typeof g.id !== "string") continue;
        const price = isObject(g.price) ? num(g.price.secure) : null;
        if (price === null || price <= 0) continue;
        // `availability` is NONE|LOW|MEDIUM|HIGH. If it is ever missing, let createPod be the judge.
        const level = typeof g.availability === "string" ? g.availability : null;
        offers.push({ id: g.id, pricePerHour: price, inStock: g.secure !== false && level !== "NONE" });
      }
      return offers;
    },

    async createPod(req) {
      const pod = (await (await call("POST", "/pods", req)).json()) as unknown;
      const parsed = parsePod(pod);
      if (!parsed) throw new RunpodError(502, "createPod returned no pod id");
      return { id: parsed.id, costPerHour: isObject(pod) ? num(pod.cost) : null };
    },

    async terminatePod(id) {
      try {
        await call("DELETE", `/pods/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof RunpodError && e.status === 404) return; // already gone
        throw e;
      }
    },

    async listPods() {
      const pods: PodSummary[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const qs = new URLSearchParams({ limit: "1000" });
        if (cursor) qs.set("cursor", cursor);
        const body = (await (await call("GET", `/pods?${qs}`)).json()) as unknown;
        const list = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.pods) ? body.pods : [];
        for (const p of list) {
          const parsed = parsePod(p);
          if (parsed) pods.push(parsed);
        }
        const pg = isObject(body) && isObject(body.pagination) ? body.pagination : null;
        cursor = pg && pg.hasNextPage === true && typeof pg.nextCursor === "string" ? pg.nextCursor : null;
        if (!cursor) break;
      }
      return pods;
    },
  };
}

// ---- RUNPOD_MOCK=1: fake pods held in memory, never touches Runpod. ----

const DEFAULT_OFFERS: GpuOffer[] = [
  { id: "NVIDIA A40", pricePerHour: 0.44, inStock: true },
  { id: "NVIDIA RTX A6000", pricePerHour: 0.49, inStock: true },
  { id: "NVIDIA L40S", pricePerHour: 0.86, inStock: true },
];

export const mockRunpod = {
  offers: DEFAULT_OFFERS.map((o) => ({ ...o })),
  pods: new Map<string, PodSummary & { request: CreatePodRequest }>(),
  /** GPU types whose createPod fails with a 400 "no capacity". */
  noCapacity: new Set<string>(),
  terminated: [] as string[],
  reset() {
    this.offers = DEFAULT_OFFERS.map((o) => ({ ...o }));
    this.pods.clear();
    this.noCapacity.clear();
    this.terminated = [];
  },
};

const mockClient: Runpod = {
  async listGpuOffers() {
    return mockRunpod.offers.map((o) => ({ ...o }));
  },
  async createPod(req) {
    if (mockRunpod.noCapacity.has(req.gpu.id))
      throw new RunpodError(400, "There are no longer any instances available with the requested specifications.");
    const offer = mockRunpod.offers.find((o) => o.id === req.gpu.id);
    const id = `mock-${crypto.randomUUID().slice(0, 8)}`;
    const costPerHour = offer?.pricePerHour ?? 0;
    mockRunpod.pods.set(id, { id, name: req.name, status: "RUNNING", costPerHour, request: req });
    console.log(`[runpod mock] created ${id} (${req.name}, ${req.gpu.id}, $${costPerHour}/h)`);
    return { id, costPerHour };
  },
  async terminatePod(id) {
    mockRunpod.pods.delete(id);
    mockRunpod.terminated.push(id);
    console.log(`[runpod mock] terminated ${id}`);
  },
  async listPods() {
    return [...mockRunpod.pods.values()].map(({ request: _r, ...p }) => p);
  },
};

export const runpod = (env: Env): Runpod => (settings(env).mock ? mockClient : restRunpod(env));
