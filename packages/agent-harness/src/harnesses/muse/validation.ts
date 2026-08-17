/**
 * Muse Code harness option validation.
 */

import { assertModeSupported } from "../../modes.js";
import type { AgentHarness, AgentRunOptions } from "../../types.js";
import {
  MUSE_INTERACTIVE_ONLY_FLAGS,
  MUSE_OPTION_KEYS,
  MUSE_REASONING_EFFORT_VALUES,
} from "./constants.js";
import type { MuseHarnessOptions, MuseReasoningEffort } from "./types.js";

export class MuseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuseConfigError";
  }
}

/**
 * Reject interactive-only CLI flags if passed through unknown config keys.
 *
 * @param rawKeys - Keys from a caller-supplied options bag.
 */
export function rejectInteractiveOnlyFlags(rawKeys: readonly string[]): void {
  for (const key of rawKeys) {
    const normalized = key.replace(/^-+/, "").replace(/_/g, "-");
    if ((MUSE_INTERACTIVE_ONLY_FLAGS as readonly string[]).includes(normalized)) {
      throw new MuseConfigError(
        `Muse Code headless runs do not support "--${normalized}". ` +
          `Use --disable-approval or --yolo via muse.yolo / muse.disableApproval in harness options instead.`,
      );
    }
  }
}

/**
 * Validate unknown keys in a muse options object.
 *
 * @param muse - Caller-provided Muse options.
 */
export function validateMuseOptionKeys(muse: Record<string, unknown>): void {
  for (const key of Object.keys(muse)) {
    if (!(MUSE_OPTION_KEYS as readonly string[]).includes(key)) {
      throw new MuseConfigError(
        `Unknown Muse harness option "${key}". Supported keys: ${MUSE_OPTION_KEYS.join(", ")}.`,
      );
    }
    rejectInteractiveOnlyFlags([key]);
  }
}

/**
 * Validate reasoning effort before launch.
 *
 * @param effort - Requested reasoning effort.
 */
export function validateReasoningEffort(effort: string): asserts effort is MuseReasoningEffort {
  if (effort === "none") {
    throw new MuseConfigError(
      'Muse Code does not support reasoning effort "none". ' +
        `Supported values: ${MUSE_REASONING_EFFORT_VALUES.join(", ")}.`,
    );
  }
  if (!(MUSE_REASONING_EFFORT_VALUES as readonly string[]).includes(effort)) {
    throw new MuseConfigError(
      `Invalid Muse reasoning effort "${effort}". ` +
        `Supported values: ${MUSE_REASONING_EFFORT_VALUES.join(", ")}.`,
    );
  }
}

/**
 * Validate Muse harness run options before process launch.
 *
 * @param harness - Muse harness instance.
 * @param options - Full agent run options.
 * @throws {MuseConfigError} when configuration is invalid.
 */
export function validateMuseRunOptions(harness: AgentHarness, options: AgentRunOptions): void {
  assertModeSupported(harness, options.mode);

  const muse = (options.muse ?? {}) as Record<string, unknown>;
  validateMuseOptionKeys(muse);

  const typed = options.muse as MuseHarnessOptions | undefined;
  if (typed?.reasoningEffort) {
    validateReasoningEffort(typed.reasoningEffort);
  }

  if (typed?.yolo === true && typed?.disableApproval === false) {
    throw new MuseConfigError(
      "Muse options conflict: yolo implies disable-approval; do not set muse.disableApproval=false with muse.yolo=true.",
    );
  }

  if (typed?.allowWorkspaceSwitch && !typed?.sessionId) {
    throw new MuseConfigError(
      "Muse option muse.allowWorkspaceSwitch requires muse.sessionId for session continuation.",
    );
  }
}

/**
 * Resolve effective Muse permission flags for unattended runs.
 *
 * Default: `--disable-approval` when skipPermissions is true (safest unattended).
 * `--yolo` only when explicitly requested via muse.yolo.
 *
 * @param options - Agent run options.
 */
export function resolveMusePermissionFlags(options: AgentRunOptions): {
  disableApproval: boolean;
  yolo: boolean;
  trustWorkspace: boolean;
} {
  const muse = options.muse;
  const yolo = muse?.yolo === true;

  if (yolo) {
    return {
      yolo: true,
      disableApproval: true,
      trustWorkspace: muse?.trustWorkspace ?? true,
    };
  }

  const disableApproval =
    muse?.disableApproval ??
    (options.skipPermissions === true ? true : muse?.disableApproval === true);

  return {
    yolo: false,
    disableApproval: disableApproval === true,
    trustWorkspace: muse?.trustWorkspace === true,
  };
}
