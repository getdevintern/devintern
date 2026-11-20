/**
 * Guidance for the `deepseek` / `reasonix` harness split.
 *
 * Before the split, `AGENT_HARNESS=deepseek` ran the community Reasonix CLI.
 * It now selects DeepSeek's official `dsh` CLI, so a stale
 * `DEEPSEEK_CLI_PATH` / `AGENT_CLI_PATH` can still point at a `reasonix`
 * binary. Shared by resolver warnings and the invocation guard so the two
 * cannot drift apart.
 */

/** Actionable guidance for a configuration that still selects Reasonix. */
export const DEEPSEEK_REASONIX_MIGRATION_HINT =
  'The community Reasonix CLI is the separate harness id "reasonix": set ' +
  "AGENT_HARNESS=reasonix to keep using Reasonix, or install the official dsh " +
  "CLI (npm i -g @deepseek-ai/dsh) for the official harness.";

/**
 * Whether a path/command points at the community Reasonix CLI binary.
 *
 * @param path - Resolved or configured CLI path.
 * @returns Whether the basename is `reasonix`.
 */
export function isReasonixBinary(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base === "reasonix" || base === "reasonix.exe";
}
