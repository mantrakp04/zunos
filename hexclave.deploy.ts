// zunos services deployed with `npx hexclave deploy` (see apps/api/README.md).
import type { HexclaveDeploymentConfig } from "@hexclave/js";

export const deploymentGroupId = "zunos";

// Hexclave's GCP runtime. On it every service output (url/hostname) waits for its target to deploy, so the
// api can't reference its own URL: PUBLIC_URL is a secret, set once the first deploy has given it a URL.
export const version = "gcp-beta-1";

export const deploy: HexclaveDeploymentConfig = ({ isDev, secret, hexclave }) => ({
  services: {
    // The training backend (apps/api): an Elysia server on Bun. One always-on instance, because the reaper
    // runs inside it and its SQLite database and blob store live on the volume.
    api: {
      type: "server",
      public: true,
      ports: { 3000: { protocol: "http" } },
      memory: "1GB",
      persistentVolumes: { data: { path: "/data", sizeGb: 50 } },
      image: "oven/bun:1.3.14",
      // The whole repo is uploaded (minus .gitignore'd files and node_modules) and copied to /app.
      // Only the api workspace's runtime dependencies are installed.
      rootDirectory: ".",
      buildCommand: "bun install --frozen-lockfile --production --filter @zunos/api",
      startCommand: "bun /app/apps/api/src/index.ts",
      // `hexclave dev --config-file hexclave.config.ts --service-id api` runs this from the repo root. The
      // values guarded by isDev come from your shell or apps/api/.env instead (see .env.example).
      devCommand: "cd apps/api && bun --watch src/index.ts",
      env: {
        HEXCLAVE_PROJECT_ID: hexclave.projectId,
        HEXCLAVE_API_URL: hexclave.apiUrl,
        HEXCLAVE_PUBLISHABLE_CLIENT_KEY: hexclave.publishableClientKey,

        // Project Settings → Secrets in the Hexclave dashboard.
        RUNPOD_API_KEY: isDev ? null : secret("RUNPOD_API_KEY"),
        HF_TOKEN: isDev ? null : secret("HF_TOKEN", ""),
        BLOB_SIGNING_SECRET: isDev ? null : secret("BLOB_SIGNING_SECRET"),
        ALLOWED_EMAILS: isDev ? null : secret("ALLOWED_EMAILS"),
        // The api's own public URL (e.g. its platform URL from the dashboard). Empty until set: the server
        // runs, but refuses to create or start runs (503 not_configured).
        PUBLIC_URL: isDev ? null : secret("PUBLIC_URL", ""),

        DATA_DIR: isDev ? null : "/data",
        RUNPOD_MOCK: isDev ? null : "0",
        POD_IMAGE: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
        GPU_TYPES: "NVIDIA A40,NVIDIA RTX A6000,NVIDIA L40S",
        // The owner's budget: everything on the Runpod account together, USD per hour.
        MAX_HOURLY_USD: "2",
        MAX_RUN_HOURS: "4",
      },
    },
  },
});
