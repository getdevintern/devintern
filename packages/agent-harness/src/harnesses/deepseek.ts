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
 * as unsupported arguments. Headless also disables the managed credential
 * store: authentication resolves from the launch environment, then
 * `<cwd>/.env`, then `$DSH_HOME/.env` (for example `DEEPSEEK_API_KEY`).
 *
 * @see https://github.com/deepseek-ai/deepseek-harness
 * @see https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md
 * @see https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless
 */

import { assertModeSupported } from "../modes.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

/** dsh version whose headless CLI surface this adapter was verified against. */
export const DEEPSEEK_TESTED_VERSION = "0.2.1-rc.2";

/** Where users configure the headless profile's model and reasoning level. */
export const DEEPSEEK_HEADLESS_PROFILE_PATH = "$DSH_HOME/profiles/headless/cordis.patch.yml";

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
   * Build `dsh headless` flags for a non-interactive one-task run.
   *
   * @param options - Supports `structuredOutput` (`--json`). `model`, `effort`,
   *   `skipPermissions`, and `maxTurns` have no headless CLI equivalent and are
   *   ignored; an explicit model emits actionable guidance.
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

    if (options.structuredOutput) {
      args.push("--json");
    }

    // Headless runs one task to completion: no --max-turns, --model, --effort,
    // or permission-skip flags exist. Workspace writes are governed by the
    // profile's permission preset (workspace-write by default) and
    // DSH_PERMISSION_MODE.

    return args;
  }
}
