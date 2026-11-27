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

/**
 * Build `tag` from a temporary context. `files` maps context names to source
 * paths (files or directories) relative to this package.
 */
export async function buildImage(tag: string, files: Record<string, string>): Promise<void> {
  const context = mkdtempSync(join(tmpdir(), "devintern-e2e-image-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      cpSync(resolve(packageRoot, source), join(context, name), { recursive: true });
    }
    const result = await docker(["build", "-q", "-t", tag, context], 900_000);
    if (result.exitCode !== 0) {
      throw new Error(`docker build failed:\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/** Build the image from the packed CLI tarball and the deterministic agent. */
export function buildServiceImage(tarball: string): Promise<void> {
  return buildImage(SERVICE_IMAGE, {
    Dockerfile: "infrastructure/service/Dockerfile",
    "cli.tgz": tarball,
    "fake-agent.ts": "helpers/fake-agent.ts",
    "simple-project": "fixtures/simple-project",
  });
}

export interface SystemdContainerOptions {
  /** Image to run (default {@link SERVICE_IMAGE}). */
  image?: string;
  /** Container name prefix; a random suffix is appended. */
  namePrefix?: string;
}

export class SystemdContainer {
  readonly name: string;
  private readonly image: string;
  private started = false;

  constructor(options: SystemdContainerOptions = {}) {
    this.image = options.image ?? SERVICE_IMAGE;
    this.name = `${options.namePrefix ?? "devintern-e2e-systemd"}-${crypto.randomUUID().slice(0, 8)}`;
  }

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
      this.image,
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

  /**
   * Run a script as `user` the way a person at a fresh shell would:
   * `docker exec -u <user>` with no `-i`/`-t` (stdin closed, no TTY) and a
   * login shell (`bash -l -c`), so PATH comes only from the user's profile.
   * Nothing but the telemetry and update opt-outs is injected; there is no
   * XDG_RUNTIME_DIR, bus address, git identity or credential.
   */
  login(user: string, script: string, timeout = 180_000): Promise<CommandResult> {
    return docker(
      [
        "exec",
        "-u",
        user,
        "-w",
        `/home/${user}`,
        ...BASE_ENV.flatMap((entry) => ["-e", entry]),
        this.name,
        "bash",
        "-l",
        "-c",
        script,
      ],
      timeout,
    );
  }

  /**
   * Write `content` to `path` as `user` with mode 0600. The content travels
   * on stdin, never in argv, so secrets stay out of process listings.
   */
  async writePrivateFile(user: string, path: string, content: string): Promise<void> {
    const result = await docker(
      ["exec", "-i", "-u", user, this.name, "sh", "-c", 'umask 077 && cat > "$1"', "sh", path],
      30_000,
      content,
    );
    if (result.exitCode !== 0) throw new Error(`could not write ${path}: ${result.stderr}`);
  }

  /** Append `content` to `path` as `user`, like {@link writePrivateFile}; a new file is 0600. */
  async appendPrivateFile(user: string, path: string, content: string): Promise<void> {
    const result = await docker(
      ["exec", "-i", "-u", user, this.name, "sh", "-c", 'umask 077 && cat >> "$1"', "sh", path],
      30_000,
      content,
    );
    if (result.exitCode !== 0) throw new Error(`could not append to ${path}: ${result.stderr}`);
  }

  /** Copy a host file into the container, readable by every user. */
  async copyIn(source: string, target: string): Promise<void> {
    const copied = await docker(["cp", source, `${this.name}:${target}`]);
    if (copied.exitCode !== 0) throw new Error(`docker cp failed: ${copied.stderr}`);
    const chmod = await this.root(`chmod 644 '${target}'`);
    if (chmod.exitCode !== 0) throw new Error(`chmod ${target} failed: ${chmod.stderr}`);
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
