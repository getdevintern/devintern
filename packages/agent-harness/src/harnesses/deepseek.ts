/**
 * DeepSeek Harness (official `dsh` CLI) — experimental.
 *
 * CLI: dsh headless [--json] <prompt>
 *
 * DeepSeek Harness is DeepSeek's official agent harness and is still in
 * developer preview; upstream explicitly warns that compatibility-breaking
 * changes will land. This adapter targets the shipped `headless` profile,
 * verified against `@deepseek-ai/dsh` 0.2.1-rc.2:
 *
 * - `dsh headless "<task>"` answers one task and exits (the shorthand for
 *   `dsh --profile headless`). The task may also arrive on stdin.
 * - `--json` replaces final-text stdout with a newline-delimited event stream.
 * - `--session-id <id>` adopts a persisted session; DevIntern does not expose
 *   session resumption, so it is not emitted.
 *
 * Headless mode has no model, reasoning-effort, max-turns, or permission-skip
 * flags. The model and reasoning level come from the dsh profile
 * (`$DSH_HOME/profiles/headless/cordis.patch.yml`), so `AGENT_MODEL` /
 * `AGENT_EFFORT` are ignored with actionable warnings instead of being passed
 * as unsupported arguments. Unattended runs still need a permission setting:
 * see {@link DeepSeekHarness.buildEnv}, which maps DevIntern's
 * `skipPermissions` to the profile's `DSH_PERMISSION_MODE`. Headless also
 * disables the managed credential store: authentication resolves from the
 * launch environment, then `<cwd>/.env`, then `$DSH_HOME/.env` (for example
 * `DEEPSEEK_API_KEY`).
 *
 * @see https://github.com/deepseek-ai/deepseek-harness
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md
 * @see https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless
 */

import { assertModeSupported, effectiveSkipPermissions } from "../modes.js";
import { parseMajorVersion, readCliVersion } from "../probe.js";
import type { AgentHarness, AgentRunOptions, HarnessProbe } from "../types.js";

/** dsh version whose headless CLI surface this adapter was verified against. */
export const DEEPSEEK_TESTED_VERSION = "0.2.1-rc.2";

/** Where users configure the headless profile's model and reasoning level. */
export const DEEPSEEK_HEADLESS_PROFILE_PATH = "$DSH_HOME/profiles/headless/cordis.patch.yml";

/**
 * Turn caps DevIntern's own workflows supply internally (500 for Code
 * implementation/review, 10 for Code analysis, 100 for PM story runs). They
 * have no headless equivalent but are not user configuration, so warning about
 * them on every run would be noise. Any other value means the user asked for a
 * specific cap.
 */
const INTERNAL_TURN_CAPS = new Set([10, 100, 500]);

export class DeepSeekHarness implements AgentHarness {
  readonly name = "deepseek";
  readonly displayName = "DeepSeek Harness (experimental)";
  readonly defaultPath = "dsh";
  /** Headless has no documented plan/read-only enforcement flag. */
  readonly supportedModes = [] as const;
  /** `--json` emits newline-delimited run events (session/final/text/tool events). */
  readonly supportsStructuredOutput = true;
  /** Effort is profile configuration only; there is no headless CLI flag. */
  readonly supportsEffort = false;
  readonly effortUnsupportedHint =
    `Configure reasoning effort in ${DEEPSEEK_HEADLESS_PROFILE_PATH}; ` +
    "the dsh headless profile does not read AGENT_EFFORT.";

  /**
   * Detect the installed `dsh` version and warn when it differs from the one
   * this adapter was verified against.
   *
   * Upstream is in developer preview and promises breaking changes, so an
   * unexpected version is surfaced immediately instead of failing later with a
   * raw parser/usage error. The warning is best-effort and never aborts a run.
   *
   * @param executablePath - Resolved `dsh` command or path.
   * @returns The detected version snapshot, or `{}` when it cannot be read.
   */
  probe(executablePath: string): HarnessProbe {
    const raw = readCliVersion(executablePath);
    if (raw === undefined) {
      return {};
    }
    const version = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? raw;
    if (version !== DEEPSEEK_TESTED_VERSION) {
      console.warn(
        `⚠️  DeepSeek Harness (${this.name}, experimental) is ${version}, but this adapter was ` +
          `verified against ${DEEPSEEK_TESTED_VERSION}. Headless flags may have changed; ` +
          `check the dsh CLI reference or pin @deepseek-ai/dsh@${DEEPSEEK_TESTED_VERSION}.`,
      );
    }
    return { version, major: parseMajorVersion(raw) };
  }

  /**
   * Build `dsh headless` flags for a non-interactive one-task run.
   *
   * @param options - Supports `structuredOutput` (`--json`). `model`, `effort`,
   *   `skipPermissions`, and `maxTurns` have no headless CLI equivalent and are
   *   ignored. DevIntern's internal turn caps are silent; a user-requested
   *   non-default `maxTurns` emits actionable guidance.
   * @returns Args starting with `headless`; prompt is appended as a positional argument.
   */
  buildArgs(options: AgentRunOptions): string[] {
    assertModeSupported(this, options.mode);
    const args: string[] = ["headless"];

    if (options.model) {
      console.warn(
        `⚠️  DeepSeek Harness (${this.name}, experimental) selects its model from the dsh headless profile; ` +
          `ignoring model "${options.model}". ` +
          `Set the model in ${DEEPSEEK_HEADLESS_PROFILE_PATH} and unset ` +
          `DEEPSEEK_MODEL/AGENT_MODEL for this harness.`,
      );
    }

    const ignoredOptions: string[] = [];
    if (options.maxTurns !== undefined && !INTERNAL_TURN_CAPS.has(options.maxTurns)) {
      ignoredOptions.push(`maxTurns=${options.maxTurns}`);
    }
    if (ignoredOptions.length > 0) {
      console.warn(
        `⚠️  DeepSeek Harness (${this.name}, experimental) has no headless flag for ` +
          `${ignoredOptions.join(", ")}; ignoring it. Headless runs one task to completion, and ` +
          "workspace writes follow the profile permission preset / DSH_PERMISSION_MODE.",
      );
    }

    if (options.structuredOutput) {
      args.push("--json");
    }

    // Headless runs one task to completion: no --max-turns, --model, --effort,
    // or permission-skip flags exist. Workspace writes are governed by the
    // profile's permission preset (workspace-write by default) and
    // DSH_PERMISSION_MODE (see buildEnv).

    return args;
  }

  /**
   * Map DevIntern's unattended permission default onto dsh's environment.
   *
   * `dsh headless` has no permission-skip flag. The shipped profile instead
   * reads `DSH_PERMISSION_MODE`, where `danger-full-access` also pins the
   * approval policy to `never`; the default `workspace-write` keeps approval
   * `ask`, and headless composes no interactive answerer, so any operation
   * that asks (a sandbox escalation, for example) fails closed. DevIntern's
   * implementation, review, hook-fix and PM spawns request
   * `skipPermissions: true`, so they need this mapping to run unattended.
   *
   * An explicit `DSH_PERMISSION_MODE` wins, letting users keep dsh's own
   * sandbox (`workspace-write`) or a different preset. When DevIntern's own
   * sandbox is enabled it remains the enforcement boundary.
   *
   * @param options - Per-run options; only the effective permission skip is read.
   * @returns The dsh environment overlay, or `undefined` to inherit unchanged.
   */
  buildEnv(options: AgentRunOptions): Record<string, string> | undefined {
    if (!effectiveSkipPermissions(options) || process.env.DSH_PERMISSION_MODE) {
      return undefined;
    }
    return { DSH_PERMISSION_MODE: "danger-full-access" };
  }
}
