/**
 * Opencode harness.
 *
 * CLI: opencode run <prompt> [flags]
 *
 * Uses `opencode run` for non-interactive mode. The prompt is passed as a
 * positional argument. Permissions are auto-approved with
 * `--dangerously-skip-permissions`.
 *
 * Version handling (probed via `opencode --version`, see `src/probe.ts`):
 *
 * - v1 — `run --print-logs --log-level ERROR`, working directory via `--dir`
 *   (opencode ignores the spawn cwd), and reasoning effort via `--variant`.
 * - v2 — the flag surface changed: `--log-level`, `--dir`, and `--variant` were
 *   removed. Logs are enabled through `OPENCODE_PRINT_LOGS=1` /
 *   `OPENCODE_LOG_LEVEL=ERROR`, the working directory is read from `$PWD`, and
 *   the model variant is folded into the model reference
 *   (`--model provider/model#variant`). `--standalone` runs a private server so
 *   a headless run never touches the user's shared background service.
 *
 * When the version cannot be determined the harness assumes v1 (the baseline),
 * so a probe failure degrades to today's behavior instead of breaking a run.
 *
 * Modes:
 * - plan / readonly → `--agent plan` (built-in plan agent; edits denied)
 * - Never pass `--dangerously-skip-permissions` in constrained modes.
 *
 * Constrained-mode toolset caveat (verified on opencode 1.17.7, 2026-07): the
 * plan agent refuses bash as well as write/edit/patch — the agent explores via
 * native read/grep/glob only (refusals are graceful: exit 0, no hang). Fine
 * for read-and-emit-JSON analysis; do not use for tasks that need shell.
 *
 * @see https://opencode.ai/docs/cli/
 * @see https://opencode.ai/v2/docs/migrate-v1
 */

import { effectiveSkipPermissions, isConstrainedMode, assertModeSupported } from "../modes.js";
import { parseMajorVersion, readCliVersion } from "../probe.js";
import type { AgentHarness, AgentRunOptions, HarnessProbe } from "../types.js";

export class OpencodeHarness implements AgentHarness {
  readonly name = "opencode";
  readonly displayName = "Opencode";
  readonly defaultPath = "opencode";
  readonly supportedModes = ["plan", "readonly"] as const;
  /** `--format json` streams raw JSON events (one object per line) to stdout. */
  readonly supportsStructuredOutput = true;
  /**
   * The prompt is a positional argument parsed by yargs; without this marker a
   * prompt starting with `-` (e.g. markdown frontmatter) fails with a usage
   * error. Verified `opencode run -- "<prompt>"` executes normally.
   */
  readonly endOfOptionsMarker = "--";
  /**
   * Effort applies via `--variant <level>` on v1 (opencode's documented
   * "model variant (provider-specific reasoning effort)" flag) and via the
   * `provider/model#variant` model reference on v2.
   */
  readonly supportsEffort = true;

  /**
   * Detect the installed OpenCode major version from `opencode --version`.
   *
   * @param executablePath - Resolved opencode executable path/command.
   * @returns The version snapshot, or `{}` when it cannot be read.
   */
  probe(executablePath: string): HarnessProbe {
    const version = readCliVersion(executablePath);
    if (version === undefined) {
      return {};
    }
    return { version, major: parseMajorVersion(version) };
  }

  /**
   * Build `opencode run` flags for non-interactive execution.
   *
   * @param options - Supports `mode`, `skipPermissions`, `model`, `effort`,
   *   `structuredOutput`, and `workingDir`.
   * @param probe - Version snapshot controlling v1/v2 flag selection.
   * @returns Args starting with `run`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions, probe?: HarnessProbe): string[] {
    assertModeSupported(this, options.mode);
    const v2 = isOpencodeV2(probe);
    const args: string[] = ["run"];

    if (v2) {
      // v2 dropped --log-level; logs are enabled through the environment (see
      // buildEnv). A private server keeps a headless run off the shared
      // background service and is required for server logs on stderr.
      args.push("--standalone");
    } else {
      // OpenCode can keep `run` alive after an unrecoverable provider error
      // while writing the only diagnostic to its private log file. Mirror
      // ERROR-level logs to stderr so headless callers can detect the failure
      // and terminate the stuck process instead of waiting for their timeout.
      args.push("--print-logs", "--log-level", "ERROR");
    }

    if (isConstrainedMode(options.mode)) {
      args.push("--agent", "plan");
    } else if (effectiveSkipPermissions(options)) {
      args.push("--dangerously-skip-permissions");
    }

    // v1 ignores the spawn cwd, so anchor it with --dir. v2 has no --dir and
    // reads the working directory from $PWD instead (see buildEnv).
    if (options.workingDir && !v2) {
      args.push("--dir", options.workingDir);
    }

    if (options.model) {
      const model =
        v2 && options.effort && !options.model.includes("#")
          ? `${options.model}#${options.effort}`
          : options.model;
      args.push("--model", model);
    } else if (v2 && options.effort) {
      // v2 has no --variant and no model to attach the variant to; skipping is
      // the only viable behavior.
      console.warn(
        "⚠️  Opencode v2 takes reasoning effort via the model reference " +
          "(--model provider/model#variant); set AGENT_MODEL to apply AGENT_EFFORT.",
      );
    }

    if (options.effort && !v2) {
      args.push("--variant", options.effort);
    }

    if (options.structuredOutput) {
      args.push("--format", "json");
    }

    return args;
  }

  /**
   * Environment overrides for v2: enable stderr logs, cap them at ERROR, and
   * pin the working directory (v2 reads `$PWD`, not the spawn cwd).
   *
   * @param options - Uses `workingDir`.
   * @param probe - Version snapshot controlling v1/v2 behavior.
   * @returns Overlay for v2, or `undefined` on v1.
   */
  buildEnv(options: AgentRunOptions, probe?: HarnessProbe): Record<string, string> | undefined {
    if (!isOpencodeV2(probe)) {
      return undefined;
    }
    const env: Record<string, string> = {
      OPENCODE_PRINT_LOGS: "1",
      OPENCODE_LOG_LEVEL: "ERROR",
    };
    if (options.workingDir) {
      env.PWD = options.workingDir;
    }
    return env;
  }
}

/**
 * Whether a probe indicates OpenCode v2 or newer.
 *
 * @param probe - Version snapshot; an unknown major is treated as v1.
 */
function isOpencodeV2(probe?: HarnessProbe): boolean {
  return (probe?.major ?? 1) >= 2;
}
