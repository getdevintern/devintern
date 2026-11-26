import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliPath } from "../helpers/fixture-workspace";

// Pack the built CLI the way it is published, then run the systemd suite
// against a container that installs that tarball. Fail before Docker work
// when the CLI or Docker is missing.
if (!existsSync(cliPath)) {
  throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
}
const docker = Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (docker.exitCode !== 0) {
  throw new Error("The service suite needs a running Docker daemon your user can access");
}

const packDir = mkdtempSync(join(tmpdir(), "devintern-e2e-service-pack-"));
try {
  const pack = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", packDir], {
    cwd: resolve(import.meta.dir, "../../code"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  if (pack.exitCode !== 0 || !tarball) {
    throw new Error(`bun pm pack failed:\n${pack.stdout.toString()}${pack.stderr.toString()}`);
  }

  const child = Bun.spawn(
    [process.execPath, "test", "./tests/service/systemd-service.test.ts", "--timeout", "600000"],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        DEVINTERN_E2E_SERVICE: "1",
        E2E_SERVICE_CLI_TARBALL: join(packDir, tarball),
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await child.exited;
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
