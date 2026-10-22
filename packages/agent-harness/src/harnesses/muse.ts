/**
 * Muse Code harness.
 *
 * CLI: muse exec [--prompt-file <path> | <prompt>] [flags…]
 *
 * Uses Meta's headless `muse exec` surface, which runs one prompt to
 * completion and exits. Plain text is the default so transcript-based
 * diagnostics and live output keep working; `--json` is emitted only when the
 * caller requests structured output.
 *
 * Unattended behavior:
 * - `--disable-approval` when {@link AgentRunOptions.skipPermissions} is set.
 *   It skips approval prompts but keeps Muse's OS sandbox on. `--yolo` (which
 *   also disables the sandbox and trusts the workspace) is deliberately not
 *   emitted: a review checkout must not auto-trust attacker-controlled
 *   skills/rules.
 * - `--disable-request-user-input` is always emitted for headless runs so the
 *   agent cannot block on an interactive question. The flag exists from Muse
 *   Code 1.4.9; a known-older install fails with an actionable message.
 * - On macOS under nono/srt the outer wrapper disables Muse's inner Seatbelt
 *   (nested Seatbelt is unsupported), so DevIntern also hides
 *   `~/.config/muse/auth.json` and requires `META_API_KEY` (see
 *   `museCredentialGuard` in `spawn-agent.ts`).
 * - `--max-model-steps` maps the shared `maxTurns` budget to Muse's model-step
 *   cap.
 *
 * Modes: `readonly` maps to Muse's built-in `:read-only` permission profile.
 * Muse has no headless plan mode; `plan` fails closed in `assertModeSupported`.
 *
 * Prompt size: the shared prompt builder uses {@link promptFileFlag} for
 * prompts too large for one argv entry, handing the full prompt to Muse via
 * `--prompt-file` instead of a no-op pointer.
 *
 * @see https://dev.meta.ai/docs/muse-code/extending#headless-and-ci
 * @see https://dev.meta.ai/docs/muse-code/configuration#launch-flags
 * @see https://dev.meta.ai/docs/muse-code/permissions
 */

import { assertModeSupported, effectiveSkipPermissions, isConstrainedMode } from "../modes.js";
import { parseVersion, readCliVersion } from "../probe.js";
import type { AgentHarness, AgentRunOptions, HarnessProbe } from "../types.js";

/** Muse's built-in read-only permission profile id. */
export const MUSE_READONLY_PROFILE = ":read-only";

/**
 * Oldest Muse Code release with `--disable-request-user-input`.
 *
 * Earlier builds reject the flag as an unknown argument (clap exits 2), so a
 * headless run would fail with a raw usage error instead of an actionable
 * DevIntern message. Detected from `muse --version`; an unparseable version is
 * treated as current rather than blocking the run.
 */
export const MUSE_MIN_VERSION = { major: 1, minor: 4, patch: 9 } as const;

/**
 * Whether a probe reports at least {@link MUSE_MIN_VERSION}.
 *
 * @param probe - Version snapshot, if any.
 * @returns True when the version is unknown or new enough; false when known-old.
 */
function supportsRequestUserInputFlag(probe?: HarnessProbe): boolean {
  if (probe?.major === undefined) {
    return true;
  }
  if (probe.major !== MUSE_MIN_VERSION.major) {
    return probe.major > MUSE_MIN_VERSION.major;
  }
  const minor = probe.minor ?? 0;
  if (minor !== MUSE_MIN_VERSION.minor) {
    return minor > MUSE_MIN_VERSION.minor;
  }
  return (probe.patch ?? 0) >= MUSE_MIN_VERSION.patch;
}

export class MuseHarness implements AgentHarness {
  readonly name = "muse";
  readonly displayName = "Muse Code";
  readonly defaultPath = "muse";
  /**
   * `muse exec --prompt-file <path>` reads the prompt from a file. The shared
   * prompt builder only uses it when a prompt exceeds the argv budget.
   */
  readonly promptFileFlag = "--prompt-file";
  /** `muse exec` parses positionals with clap; `--` protects dash-leading prompts. */
  readonly endOfOptionsMarker = "--";
  /** `readonly` is enforced by the documented `:read-only` permission profile. */
  readonly supportedModes = ["readonly"] as const;
  /** `--max-model-steps` caps the run, and exhaustion prints "This turn reached its step limit." */
  readonly supportsMaxTurns = true;
  /** `--json` emits JSONL events on stdout. */
  readonly supportsStructuredOutput = true;
  /** `--reasoning-effort` accepts the shared low/medium/high levels. */
  readonly supportsEffort = true;

  /**
   * Detect the installed Muse Code version from `muse --version`.
   *
   * @param executablePath - Resolved muse executable path/command.
   * @returns The version snapshot, or `{}` when it cannot be read.
   */
  probe(executablePath: string): HarnessProbe {
    const version = readCliVersion(executablePath);
    if (version === undefined) {
      return {};
    }
    const parsed = parseVersion(version);
    return parsed ? { version, ...parsed } : { version };
  }

  /**
   * Build `muse exec` flags for a non-interactive run.
   *
   * The prompt is not included: it is appended by the shared prompt builder as
   * a positional argument, or as `--prompt-file <path>` for oversized prompts.
   *
   * @param options - Supports `mode`, `skipPermissions`, `model`, `effort`,
   *   `workingDir`, `structuredOutput`, and `maxTurns`.
   * @param probe - Version snapshot; known versions below 1.4.9 fail with an
   *   actionable upgrade message because `--disable-request-user-input` is
   *   absent there.
   * @returns Args starting with `exec`; prompt is appended separately.
   */
  buildArgs(options: AgentRunOptions, probe?: HarnessProbe): string[] {
    assertModeSupported(this, options.mode);

    if (!supportsRequestUserInputFlag(probe)) {
      throw new Error(
        `Muse Code ${MUSE_MIN_VERSION.major}.${MUSE_MIN_VERSION.minor}.${MUSE_MIN_VERSION.patch} ` +
          `or newer is required (installed: ${probe?.version ?? "unknown"}). ` +
          "Upgrade Muse Code with the official installer and retry.",
      );
    }

    // Headless runs must never wait on the interactive question tool.
    const args: string[] = ["exec", "--disable-request-user-input"];

    if (isConstrainedMode(options.mode)) {
      // The profile itself is read-only; never combine it with a bypass flag.
      args.push("--permission-profile", MUSE_READONLY_PROFILE);
    } else if (effectiveSkipPermissions(options)) {
      // Keep Muse's sandbox in place; only skip the approval gate.
      args.push("--disable-approval");
    }

    // Muse roots policy-gated workspace tools at this path. Most runs already
    // inherit the spawn cwd, so this only matters when a caller passes an
    // explicit working directory (for example an analysis run).
    if (options.workingDir) {
      args.push("--workspace", options.workingDir);
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.effort) {
      args.push("--reasoning-effort", options.effort);
    }

    if (options.structuredOutput) {
      args.push("--json");
    }

    if (options.maxTurns !== undefined) {
      args.push("--max-model-steps", String(options.maxTurns));
    }

    return args;
  }
}
