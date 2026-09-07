/**
 * Native user-service support for the worker: render, detect, install, start.
 *
 * `worker init` step 7 offers to install and launch the service directly — a
 * systemd user unit on Linux (`systemctl --user`) or a launchd agent on macOS
 * (`launchctl bootstrap`). Accepting performs the copy/daemon-reload/enable
 * steps the docs used to leave to the reader; declining keeps the old
 * write-into-workspace-and-print-instructions path, which is also the
 * fallback whenever the automatic install fails, so a failure never leaves a
 * half-installed definition behind. Everything effectful (file system, command
 * runner, home directory, uid) is injectable for tests.
 *
 * The definitions stay redirection-free (`Type=simple`, no StandardOutput /
 * StandardError keys): the daemon tees its own console output into the
 * dashboard capture files (see `worker-capture.ts`), so adding a redirect
 * would hide the output from the dashboard.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir as osHomedir } from "os";
import { dirname, join } from "path";

export type RunCommandResult = {
  /** Exit code; 127 is used when the binary itself could not be spawned. */
  status: number;
  stdout: string;
  stderr: string;
};

export type RunCommandFn = (command: string, args: string[]) => Promise<RunCommandResult>;

export interface ServiceState {
  /** The definition file exists in the user-level service directory. */
  installed: boolean;
  /** The init system currently has the service loaded/active. */
  active: boolean;
}

export interface ServiceInstallResult {
  ok: boolean;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
  /** True when an existing service was updated/restarted instead of installed. */
  updated?: boolean;
}

/** Injectable environment for every service operation. */
export interface WorkerServiceDeps {
  platform?: NodeJS.Platform;
  /** Home directory for the user-level service paths (tests). */
  homedir?: string;
  /** POSIX uid used by `launchctl gui/<uid>` (tests). */
  uid?: number;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  mkdir?: (path: string) => void;
  remove?: (path: string) => void;
  run?: RunCommandFn;
}

export const SYSTEMD_UNIT_NAME = "devintern-worker.service";
export const LAUNCHD_LABEL = "com.devintern.worker";
export const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`;

function resolveDeps(deps: WorkerServiceDeps): Required<
  Omit<WorkerServiceDeps, "platform" | "uid">
> & {
  platform: NodeJS.Platform;
  uid?: number;
} {
  return {
    platform: deps.platform ?? process.platform,
    homedir: deps.homedir ?? osHomedir(),
    uid: deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    exists: deps.exists ?? ((path) => existsSync(path)),
    readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
    writeFile: deps.writeFile ?? ((path, content) => writeFileSync(path, content, "utf8")),
    mkdir: deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true })),
    remove: deps.remove ?? ((path) => rmSync(path, { force: true })),
    run: deps.run ?? defaultRun,
  };
}

const defaultRun: RunCommandFn = async (command, args) => {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { status: await proc.exited, stdout, stderr };
  } catch (error) {
    return { status: 127, stdout: "", stderr: (error as Error).message };
  }
};

/** Collapse a command's streams into one short single-line detail string. */
function commandDetail(result: RunCommandResult): string {
  const detail = [result.stderr, result.stdout]
    .map((text) => text.trim().split("\n").filter(Boolean).join("; ").trim())
    .filter(Boolean)
    .join(" | ");
  return detail.length > 0 ? detail : `exit ${result.status}`;
}

/**
 * Render a systemd service unit for the worker.
 *
 * No stdout/stderr redirection here on purpose: the daemon tees its own
 * console output into the dashboard's capture files (see `worker-capture.ts`),
 * so custom units and shell wrappers need no redirect either — adding one
 * would hide the output from the dashboard.
 *
 * @param options - Binary path, working directory, and whether to run the direct webhook service
 */
export function renderSystemdUnit(options: {
  execPath: string;
  projectDir: string;
  listen?: boolean;
}): string {
  const command = options.listen ? "webhook serve" : "worker";
  const quote = (value: string) =>
    /^[A-Za-z0-9_./:-]+$/.test(value)
      ? value.replace(/%/g, "%%")
      : `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=devintern ${options.listen ? "webhook server" : "worker"} (${options.projectDir})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${quote(options.projectDir)}
ExecStart=${quote(options.execPath)} ${command}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a per-user macOS launchd agent for the workspace worker.
 *
 * Like the systemd unit, this does not redirect stdout/stderr: the worker
 * self-captures into the dashboard's log files (see `worker-capture.ts`).
 */
export function renderLaunchdPlist(options: {
  execPath: string;
  workingDir: string;
  label?: string;
}): string {
  const label = options.label ?? LAUNCHD_LABEL;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.execPath)}</string>
    <string>worker</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

export function systemdUnitPath(homedir: string): string {
  return join(homedir, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

export function launchdAgentPath(homedir: string): string {
  return join(homedir, "Library", "LaunchAgents", LAUNCHD_PLIST_NAME);
}

async function systemdActive(run: RunCommandFn): Promise<boolean> {
  const result = await run("systemctl", ["--user", "is-active", "devintern-worker"]);
  return result.status === 0;
}

async function launchdLoaded(run: RunCommandFn, target: string): Promise<boolean> {
  const result = await run("launchctl", ["print", target]);
  return result.status === 0;
}

/**
 * Detect whether the worker service is already installed (definition in the
 * user-level directory) and/or active (loaded by the init system).
 */
export async function detectWorkerService(deps: WorkerServiceDeps = {}): Promise<ServiceState> {
  const d = resolveDeps(deps);
  if (d.platform === "linux") {
    const installed = d.exists(systemdUnitPath(d.homedir));
    return {
      installed,
      active: installed && (await systemdActive(d.run)),
    };
  }
  if (d.platform === "darwin") {
    const installed = d.exists(launchdAgentPath(d.homedir));
    if (!installed) {
      return { installed: false, active: false };
    }
    if (d.uid === undefined) {
      return { installed, active: false };
    }
    return {
      installed,
      active: await launchdLoaded(d.run, `gui/${d.uid}/${LAUNCHD_LABEL}`),
    };
  }
  return { installed: false, active: false };
}

/** Shell commands a user can paste to install and start the service by hand. */
export function manualServiceInstructions(options: {
  platform: NodeJS.Platform;
  workspaceDir: string;
}): string[] {
  if (options.platform === "linux") {
    return [
      "mkdir -p ~/.config/systemd/user",
      `cp ${join(options.workspaceDir, SYSTEMD_UNIT_NAME)} ~/.config/systemd/user/${SYSTEMD_UNIT_NAME}`,
      "systemctl --user daemon-reload",
      "systemctl --user enable --now devintern-worker",
      "# once, so the worker keeps running after you log out:",
      "loginctl enable-linger",
    ];
  }
  if (options.platform === "darwin") {
    return [
      "mkdir -p ~/Library/LaunchAgents",
      `cp ${join(options.workspaceDir, LAUNCHD_PLIST_NAME)} ~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}`,
      `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}`,
    ];
  }
  return [];
}

async function rollbackSystemd(
  d: ReturnType<typeof resolveDeps>,
  ctx: { unitPath: string; previous: string | null; wasActive: boolean },
): Promise<void> {
  try {
    if (ctx.previous === null) {
      d.remove(ctx.unitPath);
    } else {
      d.writeFile(ctx.unitPath, ctx.previous);
    }
  } catch {
    // Restoring the previous definition must not mask the original failure.
  }
  try {
    await d.run("systemctl", ["--user", "daemon-reload"]);
    if (ctx.wasActive) {
      await d.run("systemctl", ["--user", "start", "devintern-worker"]);
    }
  } catch {
    // Best effort only; the printed manual commands remain the way out.
  }
}

async function installSystemd(
  options: { workspaceDir: string; execPath: string },
  d: ReturnType<typeof resolveDeps>,
): Promise<ServiceInstallResult> {
  const unitPath = systemdUnitPath(d.homedir);
  const previous = d.exists(unitPath) ? d.readFile(unitPath) : null;
  const wasActive = await systemdActive(d.run);
  try {
    d.mkdir(dirname(unitPath));
    d.writeFile(
      unitPath,
      renderSystemdUnit({ execPath: options.execPath, projectDir: options.workspaceDir }),
    );
    const reload = await d.run("systemctl", ["--user", "daemon-reload"]);
    if (reload.status !== 0) {
      throw new Error(`systemctl --user daemon-reload failed: ${commandDetail(reload)}`);
    }
    const start = await d.run("systemctl", [
      "--user",
      ...(wasActive ? ["restart"] : ["enable", "--now"]),
      "devintern-worker",
    ]);
    if (start.status !== 0) {
      throw new Error(
        `systemctl --user ${wasActive ? "restart" : "enable --now"} devintern-worker failed: ${commandDetail(start)}`,
      );
    }
    if (!(await systemdActive(d.run))) {
      throw new Error("the devintern-worker unit does not report active after starting it");
    }
    return { ok: true, updated: wasActive };
  } catch (error) {
    await rollbackSystemd(d, { unitPath, previous, wasActive });
    return { ok: false, error: (error as Error).message };
  }
}

async function rollbackLaunchd(
  d: ReturnType<typeof resolveDeps>,
  ctx: {
    domain: string;
    target: string;
    plistPath: string;
    previous: string | null;
    wasLoaded: boolean;
    bootstrapped: boolean;
  },
): Promise<void> {
  if (ctx.bootstrapped) {
    try {
      await d.run("launchctl", ["bootout", ctx.target]);
    } catch {
      // Best effort only.
    }
  }
  try {
    if (ctx.previous === null) {
      d.remove(ctx.plistPath);
    } else {
      d.writeFile(ctx.plistPath, ctx.previous);
    }
  } catch {
    // Restoring the previous definition must not mask the original failure.
  }
  if (ctx.wasLoaded) {
    try {
      await d.run("launchctl", ["bootstrap", ctx.domain, ctx.plistPath]);
    } catch {
      // Best effort only; the printed manual commands remain the way out.
    }
  }
}

async function installLaunchd(
  options: { workspaceDir: string; execPath: string },
  d: ReturnType<typeof resolveDeps>,
): Promise<ServiceInstallResult> {
  if (d.uid === undefined) {
    return { ok: false, error: "could not determine your user id for launchctl" };
  }
  const domain = `gui/${d.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const plistPath = launchdAgentPath(d.homedir);
  const previous = d.exists(plistPath) ? d.readFile(plistPath) : null;
  const wasLoaded = await launchdLoaded(d.run, target);
  let bootstrapped = false;
  try {
    if (wasLoaded) {
      // bootstrap refuses to run while the label is loaded; unload first.
      await d.run("launchctl", ["bootout", target]);
    }
    d.mkdir(dirname(plistPath));
    d.writeFile(
      plistPath,
      renderLaunchdPlist({ execPath: options.execPath, workingDir: options.workspaceDir }),
    );
    const bootstrap = await d.run("launchctl", ["bootstrap", domain, plistPath]);
    if (bootstrap.status !== 0) {
      const legacy = await d.run("launchctl", ["load", "-w", plistPath]);
      if (legacy.status !== 0) {
        throw new Error(
          `launchctl bootstrap failed: ${commandDetail(bootstrap)} ('launchctl load -w' failed too: ${commandDetail(legacy)})`,
        );
      }
    }
    bootstrapped = true;
    if (!(await launchdLoaded(d.run, target))) {
      throw new Error("launchd does not list the agent after starting it");
    }
    return { ok: true, updated: wasLoaded };
  } catch (error) {
    await rollbackLaunchd(d, {
      domain,
      target,
      plistPath,
      previous,
      wasLoaded,
      bootstrapped,
    });
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Install the service definition into the user-level location and start it.
 * On any failure the previous state is restored (a freshly written definition
 * is removed; an existing one is put back and reloaded) so the caller can
 * fall back to the printed manual commands.
 */
export async function installWorkerService(
  options: { workspaceDir: string; execPath: string },
  deps: WorkerServiceDeps = {},
): Promise<ServiceInstallResult> {
  const d = resolveDeps(deps);
  if (d.platform === "linux") {
    return installSystemd(options, d);
  }
  if (d.platform === "darwin") {
    return installLaunchd(options, d);
  }
  return { ok: false, error: `no service definition exists for ${d.platform}` };
}
