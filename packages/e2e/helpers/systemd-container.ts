/**
 * Disposable systemd container for the native-service suite.
 *
 * The image (`infrastructure/service/Dockerfile`) is a blank Debian box with
 * systemd as PID 1 and the packed CLI installed globally for the non-root
 * `tester` user. `systemctl --user` works because lingering is enabled for
 * that user, which starts `user@1000.service` without a login session. The
 * container is privileged so systemd can manage its own cgroups; it never
 * shares the host network (the host may run a real worker on port 4400) and
 * never sees the host's home directory or service manager.
 */

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "./process";
import type { CommandResult } from "./process";

const packageRoot = resolve(import.meta.dir, "..");
export const SERVICE_IMAGE = "devintern-e2e-systemd:local";

/** Environment for `tester` commands, so `systemctl --user` reaches the user bus. */
const BUS_ENV = [
  "XDG_RUNTIME_DIR=/run/user/1000",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
];
const BASE_ENV = ["DEVINTERN_TELEMETRY_DISABLED=1", "DEVINTERN_NO_UPDATE=1"];

async function docker(args: string[], timeout = 120_000, stdin?: string): Promise<CommandResult> {
  if (stdin === undefined)
    return command(["docker", ...args], packageRoot, envForDocker(), timeout);
  const child = Bun.spawn(["docker", ...args], {
    cwd: packageRoot,
    env: envForDocker(),
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

function envForDocker(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Build the image from the packed CLI tarball and the deterministic agent. */
export async function buildServiceImage(tarball: string): Promise<void> {
  const context = mkdtempSync(join(tmpdir(), "devintern-e2e-service-image-"));
  try {
    cpSync(join(packageRoot, "infrastructure/service/Dockerfile"), join(context, "Dockerfile"));
    cpSync(tarball, join(context, "cli.tgz"));
    cpSync(join(packageRoot, "helpers/fake-agent.ts"), join(context, "fake-agent.ts"));
    cpSync(join(packageRoot, "fixtures/simple-project"), join(context, "simple-project"), {
      recursive: true,
    });
    const result = await docker(["build", "-q", "-t", SERVICE_IMAGE, context], 900_000);
    if (result.exitCode !== 0) {
      throw new Error(`docker build failed:\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

export class SystemdContainer {
  readonly name = `devintern-e2e-systemd-${crypto.randomUUID().slice(0, 8)}`;
  private started = false;

  /** Boot systemd, then enable lingering so the user manager runs. */
  async start(): Promise<void> {
    const run = await docker([
      "run",
      "-d",
      "--name",
      this.name,
      "--privileged",
      "--cgroupns=private",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/run/lock",
      SERVICE_IMAGE,
    ]);
    if (run.exitCode !== 0) throw new Error(`docker run failed:\n${run.stderr}`);
    this.started = true;
    await this.waitFor("systemd to boot", async () => {
      const state = await this.root("systemctl is-system-running");
      return /^(running|degraded)/.test(state.stdout.trim());
    });
    const linger = await this.root("loginctl enable-linger tester");
    if (linger.exitCode !== 0) throw new Error(`enable-linger failed:\n${linger.stderr}`);
    await this.waitFor("the tester user manager", async () => {
      const state = await this.root("systemctl is-active user@1000.service");
      return state.stdout.trim() === "active";
    });
  }

  /** Run a bash script as root. */
  root(script: string, timeout = 60_000): Promise<CommandResult> {
    return docker(["exec", "-i", this.name, "bash", "-s"], timeout, script);
  }

  /**
   * Run a bash script as `tester` with the user bus available. `plain` leaves
   * XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS unset, like a bare
   * `docker exec -u` or `sudo -u` shell without a PAM session.
   */
  user(script: string, timeout = 120_000, plain = false): Promise<CommandResult> {
    const env = plain ? BASE_ENV : [...BUS_ENV, ...BASE_ENV];
    return docker(
      [
        "exec",
        "-i",
        "-u",
        "tester",
        "-w",
        "/home/tester",
        ...env.flatMap((entry) => ["-e", entry]),
        this.name,
        "bash",
        "-s",
      ],
      timeout,
      script,
    );
  }

  /** Run a user script and fail with its output when it exits non-zero. */
  async checkedUser(script: string, timeout?: number): Promise<string> {
    const result = await this.user(script, timeout);
    if (result.exitCode !== 0) {
      throw new Error(
        `container script failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result.stdout;
  }

  /** Read one `systemctl --user show` property of the worker unit. */
  async unitProperty(name: string): Promise<string> {
    const result = await this.user(
      `systemctl --user show -p ${name} --value devintern-worker.service`,
    );
    return result.stdout.trim();
  }

  async waitFor(
    label: string,
    probe: () => Promise<boolean>,
    timeoutMs = 60_000,
    intervalMs = 1_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${label}\n${await this.journal()}`,
        );
      }
      await Bun.sleep(intervalMs);
    }
  }

  /** Recent worker unit journal, for failure reports. */
  async journal(): Promise<string> {
    if (!this.started) return "";
    const result = await this.user(
      "journalctl --user -u devintern-worker.service --no-pager -n 60 2>&1 || true",
    );
    return result.stdout;
  }

  async dispose(): Promise<void> {
    if (!this.started) return;
    const result = await docker(["rm", "-f", "-v", this.name]);
    if (result.exitCode !== 0) {
      throw new Error(`could not remove container ${this.name}: ${result.stderr}`);
    }
  }
}
