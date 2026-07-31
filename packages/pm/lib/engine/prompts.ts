/**
 * Prompt template loading for the engine.
 */

import { join } from "node:path";
import { readFile } from "../runtime/fs.js";
import { getModuleDir } from "../runtime/path.js";
import type { PromptStyle, SourceType } from "./types.js";

/**
 * Resolve the bundled `prompts/` directory relative to this module.
 *
 * Handles both source layout (`lib/engine/` → `../../prompts`) and the
 * bundled dist layout (`dist/index.js` → `../prompts`). Hosts that relocate
 * the package (e.g. an Electron bundle) should pass an explicit `promptsDir`
 * to `createEngine` instead.
 */
export function defaultPromptsDir(): string {
  const moduleDir = getModuleDir(import.meta.url);
  const isBundle = moduleDir.endsWith("/dist") || moduleDir.endsWith("\\dist");
  return isBundle ? join(moduleDir, "..", "prompts") : join(moduleDir, "..", "..", "prompts");
}

/**
 * Load a prompt template from disk and replace `{{key}}` placeholders.
 *
 * @param promptsDir - Root prompts directory.
 * @param sourceType - Source category (`figma`, `log`, or `prompt`).
 * @param style - Prompt style subdirectory (`technical` or `pm`).
 * @param filename - Template filename within the style directory.
 * @param replacements - Placeholder keys (without braces) mapped to values.
 * @returns The trimmed prompt text with all placeholders substituted.
 */
export async function loadPrompt(
  promptsDir: string,
  sourceType: SourceType,
  style: PromptStyle,
  filename: string,
  replacements: Record<string, string>,
): Promise<string> {
  const promptPath = join(promptsDir, sourceType, style, filename);
  let prompt = await readFile(promptPath);

  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(`{{${key}}}`, "g"), value);
  }

  return prompt.trim();
}
