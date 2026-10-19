#!/usr/bin/env bun
// Packs the pod's Python code and uploads it to R2 for training pods to download:
//   pod/code.tar.gz   python/pod + python/core (paths kept relative to the repo root, no __pycache__)
//   pod/bootstrap.sh  python/pod/bootstrap.sh, served at GET /pod/bootstrap.sh
//
// Usage (from apps/api):
//   bun scripts/upload-pod-code.ts [--bucket zunos] [--local] [--dry-run]
// Uploads go to the real bucket (`--remote`) unless --local is given, which writes to wrangler's local
// R2 store used by `wrangler dev`. Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) for remote uploads.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const apiDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(apiDir, "../..");
const bucket = option("--bucket") ?? process.env.R2_BUCKET_NAME ?? "zunos";
const target = flag("--local") ? "--local" : "--remote";
const dryRun = flag("--dry-run");

const sources = ["python/pod", "python/core"];
const bootstrap = join(repoRoot, "python/pod/bootstrap.sh");
for (const p of [...sources, "python/pod/bootstrap.sh"]) {
  if (!existsSync(join(repoRoot, p))) {
    console.error(`missing ${p} (looked in ${repoRoot})`);
    process.exit(1);
  }
}

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  console.log(`$ ${cmd.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ")}`);
  if (dryRun && cmd[0] !== "tar") return;
  const proc = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`command failed with exit code ${proc.exitCode}`);
    process.exit(proc.exitCode ?? 1);
  }
}

const work = mkdtempSync(join(tmpdir(), "zunos-pod-code-"));
const archive = join(work, "code.tar.gz");
try {
  // COPYFILE_DISABLE stops macOS tar from adding AppleDouble (._*) files.
  run(
    [
      "tar",
      "-czf",
      archive,
      "--exclude=__pycache__",
      "--exclude=*.pyc",
      "--exclude=.DS_Store",
      "--exclude=.venv",
      "--exclude=*.egg-info",
      ...sources,
    ],
    { cwd: repoRoot, env: { COPYFILE_DISABLE: "1" } },
  );
  console.log(`packed ${archive} (${(statSync(archive).size / 1024).toFixed(1)} KiB)`);

  const wrangler = ["bunx", "wrangler", "r2", "object", "put"];
  run([...wrangler, `${bucket}/pod/code.tar.gz`, "--file", archive, "--content-type", "application/gzip", target], { cwd: apiDir });
  run([...wrangler, `${bucket}/pod/bootstrap.sh`, "--file", bootstrap, "--content-type", "text/x-shellscript", target], {
    cwd: apiDir,
  });
  console.log(dryRun ? "dry run: nothing uploaded" : `uploaded to ${bucket} (${target.slice(2)})`);
} finally {
  if (process.env.KEEP_ARCHIVE) console.log(`kept ${archive}`);
  else rmSync(work, { recursive: true, force: true });
}
