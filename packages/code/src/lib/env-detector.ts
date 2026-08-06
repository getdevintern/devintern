import { readFileSync } from "node:fs";

export type AutomatedEnvironmentInput = {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  /** Raw `/proc/self/cgroup` text; `null` skips the cgroup check (non-Linux). */
  cgroupContents?: string | null;
};

/**
 * Detect whether the CLI is running in an automated/non-interactive environment.
 *
 * Returns true only with strong evidence (CI env vars, or a real systemd
 * .service unit). Desktop sessions on Linux inherit INVOCATION_ID /
 * JOURNAL_STREAM / SYSTEMD_EXEC_PID into every terminal, so those alone must
 * not count as automated.
 *
 * Piped output alone does not count as automated.
 *
 * @param input - Optional overrides for tests
 * @returns `true` when running under CI, a systemd service, or similar unattended context
 */
export function isAutomatedEnvironment(input: AutomatedEnvironmentInput = {}): boolean {
  const env = input.env ?? process.env;
  const pid = input.pid ?? process.pid;

  // CI systems (GitHub Actions, GitLab CI, Travis, etc.)
  if (env.CI) {
    return true;
  }

  // Direct ExecStart of a systemd unit (PID matches the one systemd recorded).
  // Children of wrapper scripts won't match, so the cgroup check below covers them.
  const execPid = env.SYSTEMD_EXEC_PID;
  if (execPid && execPid === String(pid)) {
    return true;
  }

  // Process is inside a systemd .service cgroup (timers, oneshots, cron.service).
  // Desktop apps and terminals live in .scope units and must not match.
  const cgroupContents =
    input.cgroupContents !== undefined ? input.cgroupContents : readSelfCgroup();
  if (cgroupContents != null && cgroupIndicatesSystemdService(cgroupContents)) {
    return true;
  }

  return false;
}

/**
 * True when the cgroup path's leaf unit is a `.service` (not a `.scope`).
 * `user@UID.service` is the session manager itself and does not count.
 *
 * @param cgroupContents - Raw `/proc/self/cgroup` text
 */
export function cgroupIndicatesSystemdService(cgroupContents: string): boolean {
  for (const line of cgroupContents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // cgroup v2: "0::/path/to/unit.service"
    // cgroup v1: "name=systemd:/path/to/unit.service"
    const path = trimmed.includes(":/")
      ? trimmed.slice(trimmed.indexOf(":/") + 1)
      : (trimmed.split(":").pop() ?? "");
    const leaf = path.split("/").filter(Boolean).pop() ?? "";
    // systemd escapes some chars as \x2d etc.; suffix check is enough.
    if (leaf.endsWith(".service") && !/^user@\d+\.service$/.test(leaf)) {
      return true;
    }
  }
  return false;
}

function readSelfCgroup(): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return null;
  }
}

/**
 * Detect whether stdout is attached to a TTY.
 *
 * @returns `true` when output goes to an interactive terminal
 */
export function isTtyOutput(): boolean {
  return !!process.stdout.isTTY;
}

/**
 * Return a short human-readable label for the detected runtime mode.
 *
 * @returns `"interactive"` or `"automated"`
 */
export function getRuntimeMode(): "interactive" | "automated" {
  return isAutomatedEnvironment() ? "automated" : "interactive";
}
