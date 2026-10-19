# @zunos/api

The zunos training backend: an [Elysia](https://elysiajs.com) server on Bun that launches Whisper fine-tuning
runs on a Runpod GPU pod paid for by the app owner. It holds the owner's Runpod key, admits only allow-listed
users, and keeps total GPU spend under `MAX_HOURLY_USD`. It is deployed with Hexclave deployments
(`hexclave.deploy.ts` at the repo root) as a single always-on server with a persistent volume.

- **Database**: SQLite (`bun:sqlite`, WAL) at `${DATA_DIR}/zunos-api.db`, one row per run. The schema lives
  in `src/migrations.ts` and is applied at startup (`PRAGMA user_version` records the version).
- **Files**: a blob store under `${DATA_DIR}/blobs/` holds datasets, trained models and the pod code. The Mac
  app and the pods reach it with signed URLs served by this server (below). Uploads and downloads are
  streamed to and from disk, never held in memory.
- **Reaper**: runs at startup and every 5 minutes inside the server.
- **Pod code**: at startup the server packs `python/pod` and `python/core` from the repo it runs from into
  `pod/code.tar.gz`, and serves `python/pod/bootstrap.sh` at `GET /pod/bootstrap.sh`. Redeploying ships new
  pod code; runs already started keep the archive they downloaded.

The Mac app's client is `apps/mac/src/services/training.ts`. The pod side is `python/pod/bootstrap.sh` and
`python/pod/run.py`. Source layout: `src/app.ts` maps routes onto the platform-free modules (`runs.ts`,
`events.ts`, `blobs.ts`, `budget.ts`, `lifecycle.ts`, `reaper.ts`, `runpod.ts`, `auth.ts`, `db.ts`), and
`src/index.ts` wires them up and listens on `PORT`.

## Local development

```sh
bun install                    # from the repo root
cd apps/api
cp .env.example .env           # keep RUNPOD_MOCK=1
hexclave dev --config-file ../../hexclave.config.ts -- bun --watch src/index.ts    # same as `bun run dev`
```

`hexclave dev` starts the local Hexclave dev environment and passes `HEXCLAVE_PROJECT_ID`,
`HEXCLAVE_PUBLISHABLE_CLIENT_KEY` and `HEXCLAVE_API_URL` to the server; everything else comes from `.env`
(Bun loads it). From the repo root, `hexclave dev --config-file hexclave.config.ts --service-id api` runs the
service's `devCommand` from the deploy file instead, with the same result: secrets are left to `.env` there,
because `hexclave dev` can't resolve a secret without a default.

The server listens on <http://localhost:3000> and keeps its data in `apps/api/data/` (gitignored). With
`RUNPOD_MOCK=1` nothing is created on Runpod; fake pods live in memory. A real pod can't reach localhost, so
end-to-end runs need a deploy or a tunnel as `PUBLIC_URL`.

## Deploying

```sh
npx hexclave login             # once
npx hexclave deploy            # from the repo root
```

`hexclave.deploy.ts` declares one service, `api`, on Hexclave's GCP runtime (`export const version =
"gcp-beta-1"`): `type: "server"` (one always-on instance), `public: true`, port 3000 (HTTP), `memory: "1GB"`,
and a 50 GB persistent volume mounted at `/data`. It builds on `oven/bun:1.3.14`: the repo (minus
`.gitignore`d files and `node_modules`) is copied to `/app`, `bun install --frozen-lockfile --production
--filter @zunos/api` installs only this workspace's runtime dependencies, and `bun /app/apps/api/src/index.ts`
starts it. A server with a volume needs a paid Hexclave plan, and so does a volume over 10 GB.

The SQLite file and the blob store are on the volume, so the service must stay a single instance. Don't move
the volume to another service id: the new service would get an empty disk.

### Secrets

Set these in the Hexclave dashboard under Project Settings → Secrets before deploying. The deploy fails up
front if one without a default is missing.

| Secret | Required | Purpose |
| --- | --- | --- |
| `RUNPOD_API_KEY` | yes | Owner's Runpod key |
| `BLOB_SIGNING_SECRET` | yes | HMAC key for blob URLs; 32+ random characters (`openssl rand -hex 32`). Changing it invalidates every outstanding URL |
| `ALLOWED_EMAILS` | yes | Who may train, comma-separated, case-insensitive |
| `HF_TOKEN` | no (default empty) | Passed to the pod (IndicF5 is a gated HF repo) |
| `PUBLIC_URL` | no (default empty) | The api's own public URL, e.g. its platform URL |

`PUBLIC_URL` is a secret rather than a reference to the service's own URL because a service can't reference
its own outputs: the CLI rejects `service("api").url()` inside `api`, and on the GCP runtime every service
output waits for its target to deploy. So: deploy once, copy the api's URL from the dashboard into the
`PUBLIC_URL` secret (or use a custom domain), and deploy again. Until then the server runs, but creating or
starting a run answers `503 not_configured`. Set the Mac app's API URL to the same value.

`HEXCLAVE_PROJECT_ID`, `HEXCLAVE_API_URL` and `HEXCLAVE_PUBLISHABLE_CLIENT_KEY` come from the managed Hexclave
backend (`hexclave.*` in the deploy file), and the non-secret settings are literals there.

### Configuration

| Name | Default | Purpose |
| --- | --- | --- |
| `HEXCLAVE_PROJECT_ID`, `HEXCLAVE_PUBLISHABLE_CLIENT_KEY` | | Hexclave project the app signs in with |
| `HEXCLAVE_API_URL` | `https://api.hexclave.com` | |
| `ALLOWED_EMAILS` | empty (nobody) | Comma-separated, case-insensitive |
| `RUNPOD_API_KEY` | | Owner's Runpod key |
| `RUNPOD_API_URL` | `https://api.runpod.io/v2` | Override for tests or a proxy |
| `RUNPOD_MOCK` | `0` | `1` = never call Runpod; pods are faked in memory |
| `HF_TOKEN` | | Passed to the pod |
| `PUBLIC_URL` | | This server's public origin; pods fetch bootstrap.sh, post events and use blob URLs here |
| `BLOB_SIGNING_SECRET` | | HMAC-SHA256 key for blob URLs |
| `DATA_DIR` | `apps/api/data` (`/data` in production) | Database and blob store |
| `REPO_DIR` | the repo root, from the source file's location | Where `python/pod` and `python/core` are read from |
| `PORT` | `3000` | |
| `POD_IMAGE` | `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404` | |
| `GPU_TYPES` | `NVIDIA A40,NVIDIA RTX A6000,NVIDIA L40S` | Runpod GPU type ids, priority order |
| `MAX_HOURLY_USD` | `2` | Cap on the whole account's GPU spend per hour |
| `MAX_RUN_HOURS` | `4` | Runs longer than this are stopped |

`POST /runs` refuses with `503 not_configured` if `PUBLIC_URL` or `BLOB_SIGNING_SECRET` is missing (its upload
URL would point nowhere). `POST /runs/:id/start` also needs `RUNPOD_API_KEY` (unless mocked) and the packed
pod code, so a misconfigured deploy can't start a pod that bills while doing nothing.

## API

Every app request sends `x-stack-access-token: <Hexclave access token>`. The server checks it with
`GET {HEXCLAVE_API_URL}/api/v1/users/me` (client access type, project id, publishable key, access token
headers), caches a good answer for 60 s, then requires `primary_email` to be in `ALLOWED_EMAILS`.
Responses are JSON with `Cache-Control: private, no-store`. Errors are `{error, code}`.

| Status / code | When |
| --- | --- |
| 401 `unauthorized` | No token, or Hexclave didn't return 200 |
| 403 `not_allowed` | Email not on `ALLOWED_EMAILS` ("Training is invite-only for now.") |
| 400 `bad_request` | Invalid body |
| 404 `not_found` | Unknown route or run, or someone else's run |
| 409 `run_active` | The user already has an uploading/queued/running run |
| 409 `bad_state`, `dataset_missing` | Start called twice, or before the upload finished |
| 503 `no_capacity`, `over_budget` | No configured GPU is in stock / fits the remaining budget |
| 503 `provider_unavailable`, `provider_error` | Runpod errored, or the account balance is too low |
| 503 `not_configured` | Server settings missing (see above) |

- `GET /quote` → `{gpu, pricePerHour, estimatedHours: 1.5, available, reason?}`
- `POST /runs` `{langs: ("en"|"hi"|"gu")[]}` → `201 {id, uploadUrl}`. `uploadUrl` is a signed PUT for
  `runs/<id>/dataset.tar.gz`, valid 1 hour. The app PUTs the archive to it with `Content-Type:
  application/gzip` and no auth header.
- `POST /runs/:id/start` → `RemoteRun`. Checks the dataset is stored, re-checks the budget, creates the pod.
- `GET /runs/:id` → `RemoteRun`
- `POST /runs/:id/stop` → `RemoteRun`. Terminates the pod; idempotent.
- `GET /pod/bootstrap.sh` (no auth) → `python/pod/bootstrap.sh` from the repo
- `GET|PUT /blobs/<key>?exp=&sig=` (no auth; the signature is the permission) → see below

```ts
type RemoteRun = {
  id: string;
  status: "uploading" | "queued" | "running" | "done" | "failed" | "stopped";
  stage: string | null;              // setup | data | gen | filter | train | export | upload
  costUsd: number;                   // price_per_hour × hours from pod creation to finish (or now)
  evals: { step: number; score: number; res: Record<string, unknown> }[];
  steps: { step: number; loss: number }[];   // last 500
  modelUrl: string | null;           // signed GET of runs/<id>/model.tar (24 h) once done; null once deleted
  error: string | null;
};
```

### Signed blob URLs

`GET|PUT ${PUBLIC_URL}/blobs/<key>?exp=<unix seconds>&sig=<hex>`, where `sig` is
`HMAC-SHA256(BLOB_SIGNING_SECRET, method + key + exp)` and `method` is `GET` or `PUT`. The server compares
signatures in constant time and answers `403 bad_signature` (wrong signature, key, expiry or method), `403
expired`, or `404 not_found`. A PUT streams the body to a temp file under `blobs/.tmp/` and renames it into
place, so a download never sees a half-written file. A PUT that replaces an existing key overwrites it. Bodies
up to 6 GiB are accepted (any `Content-Type`). A GET streams the file with its `Content-Length`; `HEAD`
works too.

| Key | Written by | Read by | Lifetime |
| --- | --- | --- | --- |
| `runs/<id>/dataset.tar.gz` | Mac app (PUT, 1 h URL) | pod (GET, 6 h URL) | Deleted when the run finishes |
| `runs/<id>/model.tar` | pod (PUT, 6 h URL, `Content-Type: application/x-tar`) | Mac app (GET, 24 h URL, renewed on every `GET /runs/:id`) | Deleted 7 days after the run finishes |
| `pod/code.tar.gz` | the server, at startup | pod (GET, 6 h URL) | Rebuilt on every start |

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
| `ZUNOS_CODE_URL` | Signed GET of `pod/code.tar.gz`, 6 h |
| `ZUNOS_DATASET_URL` | Signed GET of the dataset, 6 h |
| `ZUNOS_MODEL_URL` | Signed PUT for `runs/<id>/model.tar`, 6 h (single PUT, < 6 GiB) |
| `ZUNOS_EVENTS_URL` | `${PUBLIC_URL}/runs/<id>/events` |
| `ZUNOS_EVENTS_TOKEN` | Random 32-byte hex; only its SHA-256 is stored |
| `HF_TOKEN` | From the server's secret, if set |

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
| `{type:"log", line}` | Appends to the log (last 200 lines, stored in the database, not returned) |
| `{type:"done", best_step, best_score, model_bytes}` | `done` once `model.tar` is stored, else `failed`; pod terminated |
| `{type:"error", message}` | `failed` with the message; pod terminated |

## Budget

The owner's rule is that everything running on the Runpod account together stays under `MAX_HOURLY_USD`
(default $2/hour). "Committed" spend is the sum of `cost` over every live pod in `GET /v2/pods`, including
pods that aren't zunos's, plus the price of zunos runs whose pod isn't listed yet. A GPU type is offered only if
its on-demand Secure Cloud price fits in `MAX_HOURLY_USD − committed`. Quotes and starts both check this, and
a start fails closed (`503`) if Runpod can't be read. Each user has at most one active run, enforced by a
unique index.

Two starts from different users can race past the check together. The reaper catches this within 5 minutes.

## Reaper (at startup, then every 5 minutes)

- Runs with no event for 30 minutes (45 minutes while `queued`, since setup is slow) are marked `failed`
  and their pods terminated.
- Runs that have gone longer than `MAX_RUN_HOURS` are stopped the same way.
- If the account's hourly total is over `MAX_HOURLY_USD`, the newest zunos runs are stopped until it fits.
  Other pods are counted but never touched.
- Pods named `zunos-run-*` with no active run are terminated (a failed terminate, a crash between creating
  the pod and saving its id, a finished run). Pods with other names are never touched.
- Runs still `uploading` 3 hours after creation are marked `failed`, so they stop blocking the user.
- Finished runs' datasets are deleted (one that arrived after the run ended included), their `model.tar` 7 days
  after they finished, and temp files from uploads that died more than a day ago.

Every termination and deletion is logged as a JSON line on stdout.

## Tests

```sh
bun run test        # bun test
bun run typecheck
```

Tests call the Elysia app directly (`app.handle`) with an in-memory SQLite database, a temp blob directory,
a fake repo for the pod code, and a stubbed `fetch` for Hexclave. Most use `RUNPOD_MOCK=1`;
`test/runpod-rest.test.ts` runs the real REST client against a stubbed Runpod built from the v2 OpenAPI
response shapes. `test/blobs.test.ts` covers signed URLs (valid, expired, tampered, wrong method), atomic
writes, startup, and a 400 MiB streamed PUT and GET through the server running in its own process, checking
its memory stays flat.

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

## Hexclave deployment: what isn't confirmed

Checked against `@hexclave/cli` / `@hexclave/shared` 1.0.132 (types, the CLI's deploy-file validator) and the
Hexclave docs on 2026-10-19. The deploy file passes the CLI's own validation for the `gcp` runtime.

- Persistent volumes on `gcp-beta-1`: the types and the CLI allow them on any `server` service with no
  runtime-specific check, but nothing documents whether the GCP runtime keeps the disk across redeploys. If it
  turns out not to, `DATA_DIR` is configurable, but the database and blobs would need to move off local disk.
- Request size and timeouts for 5 GB uploads through the GCP public endpoint (load balancer limits) are
  undocumented. The server itself accepts up to 6 GiB per request.
- The platform URL format on GCP, and the working directory `startCommand` runs in (hence the absolute path
  `/app/apps/api/src/index.ts`, the location the types document).
