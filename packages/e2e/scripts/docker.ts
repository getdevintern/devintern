/**
 * `bun run --filter @devintern/e2e test:docker`: the opt-in "blank machine"
 * smoke suite for `devintern worker init --non-interactive`.
 *
 * Packs the built CLI with `bun pm pack`, builds docker/worker-init/Dockerfile
 * from a temporary context, then runs tests/docker/*.test.ts, which start one
 * fresh container per scenario (`--network none`, no TTY, stdin closed).
 * Requires a built CLI and a Docker daemon the current user can reach.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliPath } from "../helpers/fixture-workspace";

const packageRoot = resolve(import.meta.dir, "..");
const codeRoot = resolve(packageRoot, "../code");
const image = process.env.E2E_DOCKER_IMAGE ?? "devintern-e2e-worker-init:local";

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(" ")} exited with ${code}`);
}

if (!existsSync(cliPath)) {
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
}
if (!Bun.which("docker")) throw new Error("test:docker needs the docker CLI on PATH");

const context = mkdtempSync(join(tmpdir(), "devintern-e2e-docker-"));
try {
  // --ignore-scripts: pack the dist that was just built instead of rebuilding.
  await run(
    [process.execPath, "pm", "pack", "--ignore-scripts", "--destination", context, "--quiet"],
    codeRoot,
  );
  const tarball = readdirSync(context).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("bun pm pack produced no tarball");
  copyFileSync(join(context, tarball), join(context, "cli.tgz"));
  rmSync(join(context, tarball));
  copyFileSync(join(packageRoot, "docker/worker-init/Dockerfile"), join(context, "Dockerfile"));
  await run(
    [
      "docker",
      "build",
      "--quiet",
      "--tag",
      image,
      "--build-arg",
      `BUN_VERSION=${Bun.version}`,
      "--build-arg",
      `UID=${process.getuid?.() ?? 1000}`,
      context,
    ],
    context,
  );
} finally {
  rmSync(context, { recursive: true, force: true });
}

const child = Bun.spawn([process.execPath, "test", "./tests/docker", "--timeout", "180000"], {
  cwd: packageRoot,
  env: { ...process.env, DEVINTERN_E2E_DOCKER_IMAGE: image },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
