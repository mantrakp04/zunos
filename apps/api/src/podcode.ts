// The pod's Python code, packed at startup from the repo the server runs from:
//   pod/code.tar.gz   python/pod + python/core (paths kept relative to the repo root, no __pycache__ or .venv)
// and python/pod/bootstrap.sh, served at GET /pod/bootstrap.sh.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys } from "./blobs";
import { type Ctx, settings } from "./env";

export const POD_SOURCES = ["python/pod", "python/core"];

export const bootstrapPath = (ctx: Ctx) => join(settings(ctx.env).repoDir, "python/pod/bootstrap.sh");

/**
 * Packs POD_SOURCES from REPO_DIR into the blob `pod/code.tar.gz`. Returns its size, or null (and leaves any
 * existing archive alone) when the sources aren't there.
 */
export async function buildPodCode(ctx: Ctx): Promise<number | null> {
  const repo = settings(ctx.env).repoDir;
  const missing = POD_SOURCES.filter((p) => !existsSync(join(repo, p)));
  if (missing.length) {
    console.warn(JSON.stringify({ msg: "pod code not built", repo, missing }));
    return null;
  }
  const work = mkdtempSync(join(tmpdir(), "zunos-pod-code-"));
  try {
    const archive = join(work, "code.tar.gz");
    // COPYFILE_DISABLE stops macOS tar from adding AppleDouble (._*) files.
    const proc = Bun.spawnSync(
      [
        "tar",
        "-czf",
        archive,
        "--exclude=__pycache__",
        "--exclude=*.pyc",
        "--exclude=.DS_Store",
        "--exclude=.venv",
        "--exclude=*.egg-info",
        ...POD_SOURCES,
      ],
      { cwd: repo, env: { ...process.env, COPYFILE_DISABLE: "1" }, stderr: "pipe" },
    );
    if (proc.exitCode !== 0) throw new Error(`tar failed (${proc.exitCode}): ${proc.stderr.toString().slice(0, 500)}`);
    const size = await ctx.blobs.put(keys.code, Bun.file(archive).stream());
    console.log(JSON.stringify({ msg: "pod code built", key: keys.code, size }));
    return size;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
