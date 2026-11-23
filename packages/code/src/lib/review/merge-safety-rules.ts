/**
 * Operator-owned merge-safety rules (`auto_merge_policy = "custom"`).
 *
 * The rules come only from workspace config: inline `auto_merge_rules`, or
 * the file `auto_merge_rules_file` names. A relative file path resolves
 * against the workspace home, never the repository checkout, so a pull
 * request can never supply the rules it is judged by. The file is read on
 * every review, so edits apply without a config reload.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, join } from "path";

import { MAX_AUTO_MERGE_RULES_CHARS } from "./merge-gate";
import type { MergeSafetyPolicy } from "./merge-gate";

/** Where a `custom` policy's rules come from (exactly one is set). */
export interface MergeSafetyRulesSource {
  /** Inline rules text (`auto_merge_rules`). */
  rules?: string;
  /** Absolute rules file path (`auto_merge_rules_file`, resolved). */
  rulesFile?: string;
}

/** The rules text, or why it is unusable (the review then fails closed). */
export type MergeSafetyRulesResult = { ok: true; text: string } | { ok: false; problem: string };

/**
 * Resolve an `auto_merge_rules_file` value: `~` expands to the home
 * directory, and relative paths are taken from the workspace home.
 */
export function resolveRulesFilePath(file: string, workspaceDir: string): string {
  if (file === "~") return homedir();
  if (file.startsWith("~/")) return join(homedir(), file.slice(2));
  return isAbsolute(file) ? file : join(workspaceDir, file);
}

/** Read and validate a rules file; never throws. */
export function readRulesFile(path: string): MergeSafetyRulesResult {
  const name = `the rules file ${basename(path)}`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, problem: `${name} is missing` };
    if (code === "EISDIR") return { ok: false, problem: `${name} is a directory` };
    return { ok: false, problem: `${name} could not be read (${code ?? "unknown error"})` };
  }
  const text = raw.trim();
  if (!text) return { ok: false, problem: `${name} is empty` };
  if (text.length > MAX_AUTO_MERGE_RULES_CHARS) {
    return {
      ok: false,
      problem:
        `${name} is ${text.length} characters, over the ` +
        `${MAX_AUTO_MERGE_RULES_CHARS}-character limit`,
    };
  }
  return { ok: true, text };
}

/** The rules a `custom` review uses, read now. */
export function loadMergeSafetyRules(source: MergeSafetyRulesSource): MergeSafetyRulesResult {
  if (source.rulesFile) return readRulesFile(source.rulesFile);
  const text = source.rules?.trim();
  if (!text) {
    return { ok: false, problem: "no auto_merge_rules or auto_merge_rules_file is configured" };
  }
  if (text.length > MAX_AUTO_MERGE_RULES_CHARS) {
    return {
      ok: false,
      problem: `auto_merge_rules is over the ${MAX_AUTO_MERGE_RULES_CHARS}-character limit`,
    };
  }
  return { ok: true, text };
}

/** How a hold comment names the policy: the preset, or `custom: <file basename>`. */
export function mergeSafetyPolicyLabel(
  policy: MergeSafetyPolicy,
  source: MergeSafetyRulesSource = {},
): string {
  if (policy === "custom" && source.rulesFile) return `custom: ${basename(source.rulesFile)}`;
  return policy;
}
