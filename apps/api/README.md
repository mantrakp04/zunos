# @zunos/api

The zunos training backend: a Cloudflare Worker (Hono) that launches Whisper fine-tuning runs on a Runpod
GPU pod paid for by the app owner. It holds the owner's Runpod key, admits only allow-listed users, and
keeps total GPU spend under `MAX_HOURLY_USD`.

- D1 (`DB`) stores one row per run (`migrations/0001_init.sql`).
- R2 (`BUCKET`) stores datasets, trained models and the pod code. Clients and pods use presigned S3 URLs
  (aws4fetch), so large files never pass through the Worker.
- A cron trigger (every 5 minutes) runs the reaper.

The Mac app's client is `apps/mac/src/services/training.ts`. The pod side is `python/pod/bootstrap.sh` and
`python/pod/run.py`.

## Setup

```sh
bun install                                   # from the repo root
cd apps/api
bunx wrangler d1 create zunos-api             # put the printed database_id into wrangler.jsonc
bunx wrangler r2 bucket create zunos
bun run db:migrate:remote
```

Create an R2 API token (Object Read & Write on the bucket) for `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.
Then set the secrets:

```sh
bunx wrangler secret put RUNPOD_API_KEY
bunx wrangler secret put HF_TOKEN
bunx wrangler secret put R2_ACCESS_KEY_ID
bunx wrangler secret put R2_SECRET_ACCESS_KEY
```

and fill in the non-secret `vars` in `wrangler.jsonc` (`HEXCLAVE_PROJECT_ID`, `HEXCLAVE_PUBLISHABLE_CLIENT_KEY`,
`ALLOWED_EMAILS`, `R2_ACCOUNT_ID`, `PUBLIC_URL`). Upload the pod code (see below) before the first run, then
`bun run deploy`.

### Configuration

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `HEXCLAVE_PROJECT_ID` | var | | Hexclave project the app signs in with |
| `HEXCLAVE_PUBLISHABLE_CLIENT_KEY` | var | | Its publishable client key |
| `HEXCLAVE_API_URL` | var | `https://api.hexclave.com` | |
| `ALLOWED_EMAILS` | var | empty (nobody) | Comma-separated, case-insensitive |
| `RUNPOD_API_KEY` | secret | | Owner's Runpod key |
| `HF_TOKEN` | secret | | Passed to the pod (IndicF5 is a gated HF repo) |
| `R2_ACCOUNT_ID` | var | | For the S3 endpoint `https://<id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret | | R2 S3 credentials used to presign |
| `R2_BUCKET_NAME` | var | `zunos` | Must match the `BUCKET` binding |
| `PUBLIC_URL` | var | | This Worker's URL; pods fetch bootstrap.sh and post events here |
| `POD_IMAGE` | var | `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404` | |
| `GPU_TYPES` | var | `NVIDIA A40,NVIDIA RTX A6000,NVIDIA L40S` | Runpod GPU type ids, priority order |
| `MAX_HOURLY_USD` | var | `2` | Cap on the whole account's GPU spend per hour |
| `MAX_RUN_HOURS` | var | `4` | Runs longer than this are stopped |
| `RUNPOD_MOCK` | var | `0` | `1` = never call Runpod; pods are faked in memory |
| `RUNPOD_API_URL` | var | `https://api.runpod.io/v2` | Override for tests or a proxy |

`POST /runs/:id/start` refuses with `503 not_configured` if `PUBLIC_URL`, the R2 settings, or (unless mocked)
`RUNPOD_API_KEY` are missing, so a misconfigured deploy can't start a pod that bills while doing nothing.

### Local development

```sh
cp .dev.vars.example .dev.vars    # keep RUNPOD_MOCK=1
bun run db:migrate:local
bun run dev                       # http://localhost:8787
```

With `RUNPOD_MOCK=1` nothing is created on Runpod; fake pods live in the Worker's memory. A real pod can't
reach `wrangler dev`, so end-to-end runs need a deployed Worker or a tunnel as `PUBLIC_URL`.

### Uploading the pod code

```sh
bun scripts/upload-pod-code.ts --dry-run     # pack and print the commands only
bun scripts/upload-pod-code.ts               # upload to the real bucket (needs `wrangler login`)
bun scripts/upload-pod-code.ts --local       # wrangler dev's local R2
```

It packs `python/pod` and `python/core` (paths relative to the repo root, without `__pycache__`) into
`pod/code.tar.gz` and uploads it plus `python/pod/bootstrap.sh` as `pod/bootstrap.sh`, using
`wrangler r2 object put`. Re-run it whenever the pod code changes. Runs already started keep the archive they
downloaded.

## API

Every app request sends `x-stack-access-token: <Hexclave access token>`. The Worker checks it with
`GET {HEXCLAVE_API_URL}/api/v1/users/me` (client access type, project id, publishable key, access token
headers), caches a good answer for 60 s, then requires `primary_email` to be in `ALLOWED_EMAILS`.
Responses are JSON with `Cache-Control: private, no-store`. Errors are `{error, code}`.

| Status / code | When |
| --- | --- |
| 401 `unauthorized` | No token, or Hexclave didn't return 200 |
| 403 `not_allowed` | Email not on `ALLOWED_EMAILS` ("Training is invite-only for now.") |
| 400 `bad_request` | Invalid body |
| 404 `not_found` | Unknown run, or someone else's |
| 409 `run_active` | The user already has an uploading/queued/running run |
| 409 `bad_state`, `dataset_missing` | Start called twice, or before the upload finished |
| 503 `no_capacity`, `over_budget` | No configured GPU is in stock / fits the remaining budget |
| 503 `provider_unavailable`, `provider_error` | Runpod errored, or the account balance is too low |
| 503 `not_configured` | Server settings missing (see above) |

- `GET /quote` → `{gpu, pricePerHour, estimatedHours: 1.5, available, reason?}`
- `POST /runs` `{langs: ("en"|"hi"|"gu")[]}` → `201 {id, uploadUrl}`. `uploadUrl` is a presigned R2 PUT
  for `runs/<id>/dataset.tar.gz`, valid 1 hour.
- `POST /runs/:id/start` → `RemoteRun`. Checks the dataset is in R2, re-checks the budget, creates the pod.
- `GET /runs/:id` → `RemoteRun`
- `POST /runs/:id/stop` → `RemoteRun`. Terminates the pod; idempotent.
- `GET /pod/bootstrap.sh` (no auth) → R2 `pod/bootstrap.sh`

```ts
type RemoteRun = {
  id: string;
  status: "uploading" | "queued" | "running" | "done" | "failed" | "stopped";
  stage: string | null;              // setup | data | gen | filter | train | export | upload
  costUsd: number;                   // price_per_hour × hours from pod creation to finish (or now)
  evals: { step: number; score: number; res: Record<string, unknown> }[];
  steps: { step: number; loss: number }[];   // last 500
  modelUrl: string | null;           // presigned GET of runs/<id>/model.tar (24 h) once done
  error: string | null;
};
```

### The pod

The pod is created with `POST /v2/pods`:

```json
{
  "name": "zunos-run-<id>", "cloud": "SECURE", "image": "<POD_IMAGE>",
  "gpu": { "id": "<GPU type>", "count": 1, "minCudaVersion": "12.8" },
  "disk": 150, "ports": [], "env": { ... },
  "entrypoint": ["bash", "-c"], "cmd": ["curl -fsSL \"$ZUNOS_BOOTSTRAP_URL\" | bash"]
}
```

| Pod env | Value |
| --- | --- |
| `ZUNOS_RUN_ID` | Run id |
| `ZUNOS_BOOTSTRAP_URL` | `${PUBLIC_URL}/pod/bootstrap.sh` |
| `ZUNOS_CODE_URL` | Presigned GET of `pod/code.tar.gz`, 6 h |
| `ZUNOS_DATASET_URL` | Presigned GET of the dataset, 6 h |
| `ZUNOS_MODEL_URL` | Presigned PUT for `runs/<id>/model.tar`, 6 h (single PUT, < 5 GB) |
| `ZUNOS_EVENTS_URL` | `${PUBLIC_URL}/runs/<id>/events` |
| `ZUNOS_EVENTS_TOKEN` | Random 32-byte hex; only its SHA-256 is stored |
| `HF_TOKEN` | From the Worker secret |

GPU types are tried in `GPU_TYPES` order, skipping types that are out of stock or over budget. A `400` or
`403` from createPod moves on to the next type. Runpod reports "no capacity" as a plain 400 with no
machine-readable code. `402` (balance), `429` and `5xx` stop the attempt. If no pod is created, the run goes
back to `uploading` and the user can retry.

The pod reports progress with `POST /runs/:id/events`, `Authorization: Bearer <ZUNOS_EVENTS_TOKEN>`
(hashes compared in constant time). Every event updates `last_event_at`, and the first one moves the run from
`queued` to `running`. Events for a finished run get `409 run_finished`, which tells the pod to stop.

| Body | Effect |
| --- | --- |
| `{type:"stage", stage, status}` | Sets `stage` |
| `{type:"train", step, total, loss, lr}` | Appends `{step, loss}` (last 500 kept) |
| `{type:"eval", step, score, res}` | Appends to `evals` |
| `{type:"log", line}` | Appends to the log (last 200 lines, stored in D1, not returned) |
| `{type:"done", best_step, best_score, model_bytes}` | `done` once `model.tar` is in R2, else `failed`; pod terminated |
| `{type:"error", message}` | `failed` with the message; pod terminated |

## Budget

The owner's rule is that everything running on the Runpod account together stays under `MAX_HOURLY_USD`.
"Committed" spend is the sum of `cost` over every live pod in `GET /v2/pods`, including pods that aren't
zunos's, plus the price of zunos runs whose pod isn't listed yet. A GPU type is offered only if its on-demand
Secure Cloud price fits in `MAX_HOURLY_USD − committed`. Quotes and starts both check this, and a start
fails closed (`503`) if Runpod can't be read.

Two starts from different users can race past the check together. The reaper catches this within 5 minutes.

## Reaper (cron, every 5 minutes)

- Runs with no event for 30 minutes (45 minutes while `queued`, since setup is slow) are marked `failed`
  and their pods terminated.
- Runs that have gone longer than `MAX_RUN_HOURS` are stopped the same way.
- If the account's hourly total is over `MAX_HOURLY_USD`, the newest zunos runs are stopped until it fits.
  Other pods are counted but never touched.
- Pods named `zunos-run-*` with no active run are terminated (a failed terminate, a crash between creating
  the pod and saving its id, a finished run). Pods with other names are never touched.
- Runs still `uploading` 3 hours after creation are marked `failed`, so they stop blocking the user.

Every termination is logged as JSON (`wrangler tail`, or Workers Logs since `observability` is on).

## Tests

```sh
bun run test        # vitest + @cloudflare/vitest-plugin (workerd, local D1/R2)
bun run typecheck
```

Tests call the Hono app directly with stubbed `fetch` for Hexclave. Most use `RUNPOD_MOCK=1`.
`test/runpod-rest.test.ts` runs the real REST client against a stubbed Runpod built from the v2 OpenAPI
response shapes.

## Runpod REST v2 notes

Checked against the v2 OpenAPI spec (`https://docs.runpod.io/api-reference-v2/openapi.json`, version 2.0.0)
on 2026-10-19:

- **Base URL is `https://api.runpod.io/v2`**, not `https://rest.runpod.io/v2`. The spec's server is
  `https://api.runpod.io` with paths under `/v2/`. `rest.runpod.io/v2/*` answers 301 to the docs, and
  `api.runpod.io/v2/pods` answers 401 without a key. Override with `RUNPOD_API_URL` if that changes.
- Confirmed in the spec: `CreatePodRequest` fields `name`, `cloud` (`SECURE`|`COMMUNITY`), `image`,
  `gpu.{id,count,minCudaVersion}`, `disk`, `ports`, `env`, `entrypoint`, `cmd` (the body has
  `unevaluatedProperties: false`). `Pod.id`, `Pod.name`, `Pod.status` (PROVISIONING|STARTING|RUNNING|EXITED|
  ERROR|TERMINATED), `Pod.cost` (USD/h, 0 when EXITED). `GET /v2/pods` returns `{pods, pagination: {nextCursor,
  hasNextPage}}`. `DELETE /v2/pods/{id}` returns 204, and a 404 is treated as already gone.
  `GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&minCudaVersion=12.8` returns `{gpus:
  [{id, secure, price: {secure, community}, availability: NONE|LOW|MEDIUM|HIGH, ...}]}`. Errors are
  `application/problem+json` `{title, status, detail, errors?}`.
- Handled defensively because the spec doesn't pin them down: list responses are also accepted as bare
  arrays. A catalog entry with no `availability` is treated as in stock, and createPod decides. createPod's
  `cost` is used as the run's price when present, else the catalog's `price.secure`. `price.secure` is the
  list price, so negotiated discounts aren't reflected in quotes.
