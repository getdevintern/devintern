/**
 * Secure prompt file handling for Muse Code headless runs.
 */

import { chmodSync, mkdtempSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_PROMPT_FILE_THRESHOLD_BYTES } from "./constants.js";

/** Result of prompt delivery planning. */
export interface MusePromptDelivery {
  /** Extra CLI args (`--prompt-file` or positional prompt). */
  args: string[];
  /** Harness-owned temp file to delete after the run. */
  tempPromptFile?: string;
}

/**
 * Threshold above which prompts are written to a temp file.
 *
 * @returns Byte length threshold.
 */
export function musePromptFileThreshold(): number {
  const fromEnv = process.env.MUSE_PROMPT_FILE_THRESHOLD_BYTES;
  if (fromEnv) {
    const parsed = parseInt(fromEnv, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PROMPT_FILE_THRESHOLD_BYTES;
}

/**
 * Create a private prompt file with restrictive permissions.
 *
 * @param prompt - Full prompt text.
 * @returns Absolute path to the temp file.
 */
export function createMusePromptFile(prompt: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devintern-muse-prompt-"));
  const filePath = join(dir, "prompt.txt");
  writeFileSync(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms that ignore mode on create.
  }
  return filePath;
}

/**
 * Delete a harness-owned temp prompt file.
 *
 * @param filePath - Path returned from {@link createMusePromptFile}.
 */
export function cleanupMusePromptFile(filePath: string | undefined): void {
  if (!filePath) {
    return;
  }
  try {
    unlinkSync(filePath);
  } catch {
    // Already removed or never created.
  }
}

/**
 * Decide whether to pass the prompt as a positional arg or via `--prompt-file`.
 *
 * Never uses shell interpolation; values are always argv entries.
 *
 * @param prompt - Prompt text.
 * @param forcePromptFile - When true, always use a temp file.
 */
export function planMusePromptDelivery(
  prompt: string,
  forcePromptFile = false,
): MusePromptDelivery {
  const useFile = forcePromptFile || Buffer.byteLength(prompt, "utf8") > musePromptFileThreshold();

  if (useFile) {
    const tempPromptFile = createMusePromptFile(prompt);
    return {
      args: ["--prompt-file", tempPromptFile],
      tempPromptFile,
    };
  }

  return { args: [prompt] };
}
