/** Service-manager CLIs the test runner shadows with failing stubs on PATH. */
export const SERVICE_MANAGER_COMMANDS = ["systemctl", "launchctl", "loginctl"] as const;

/** Verbs that change service-manager state; read-only queries are tolerated. */
const MUTATING_VERBS = new Set([
  "daemon-reload",
  "start",
  "stop",
  "restart",
  "reload",
  "enable",
  "disable",
  "kill",
  "bootstrap",
  "bootout",
  "kickstart",
  "load",
  "unload",
  "enable-linger",
  "disable-linger",
]);

/**
 * The logged stub calls (one `<command> <args…>` per line) that would have
 * changed the real service manager's state.
 */
export function mutatingServiceCalls(log: string): string[] {
  return log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line
        .split(/\s+/)
        .slice(1)
        .some((word) => MUTATING_VERBS.has(word)),
    );
}
