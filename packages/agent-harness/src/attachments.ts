/**
 * Helpers for surfacing local file attachments to agent CLIs.
 *
 * Most harnesses receive attachments as path references in the prompt text.
 * Codex can also take images via native `-i` flags (see {@link CodexHarness}).
 */

import { basename } from "node:path";

import type { AgentHarness, AgentRunOptions } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"]);

export type AttachmentKind = "image" | "file";

export interface PromptAttachment {
  path: string;
  name?: string;
  kind?: AttachmentKind;
}

/**
 * Return true when `filePath` looks like a common image by extension.
 *
 * @param filePath - Absolute or relative path (extension only is consulted).
 */
export function isImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Classify a path as image vs generic file for prompt formatting.
 *
 * @param filePath - Local file path.
 */
export function attachmentKindForPath(filePath: string): AttachmentKind {
  return isImagePath(filePath) ? "image" : "file";
}

/**
 * Append an "Attached files" section listing local paths the agent should open.
 *
 * Dedupes by path. Images use markdown image syntax; other files use links.
 * Returns the original prompt unchanged when there are no attachments.
 *
 * @param prompt - Base prompt text.
 * @param attachments - Local files to list (paths may repeat; first wins).
 */
export function appendAttachmentPathsToPrompt(
  prompt: string,
  attachments: readonly PromptAttachment[],
): string {
  if (attachments.length === 0) {
    return prompt;
  }

  const seen = new Set<string>();
  const lines: string[] = [];

  for (const attachment of attachments) {
    const path = attachment.path.trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);

    const name = attachment.name?.trim() || basename(path);
    const kind = attachment.kind ?? attachmentKindForPath(path);
    if (kind === "image") {
      lines.push(`- **${name}**:\n  ![${name}](${path})`);
    } else {
      lines.push(`- **[${name}](${path})**`);
    }
  }

  if (lines.length === 0) {
    return prompt;
  }

  return (
    `${prompt.trimEnd()}\n\n` +
    `## Attached files\n\n` +
    `Open and read these local files before drafting. Do not invent content that contradicts them.\n\n` +
    `${lines.join("\n")}\n`
  );
}

/**
 * Build the effective prompt and trailing CLI args for attachment delivery.
 *
 * - Always injects `attachmentPaths` (plus any `imagePaths` not already listed)
 *   into the prompt as markdown paths.
 * - When the harness uses native image input, also returns `buildImageArgs` for
 *   the image subset (appended after the prompt by runners).
 *
 * @param harness - Target agent harness.
 * @param prompt - Original prompt text.
 * @param options - Run options that may include attachment/image paths.
 */
export function preparePromptWithAttachments(
  harness: AgentHarness,
  prompt: string,
  options: Pick<AgentRunOptions, "attachmentPaths" | "imagePaths">,
): { prompt: string; imageArgs: string[] } {
  const attachmentPaths = options.attachmentPaths ?? [];
  const imagePaths = options.imagePaths ?? [];

  const promptAttachments: PromptAttachment[] = [
    ...attachmentPaths.map((path) => ({
      path,
      kind: attachmentKindForPath(path),
    })),
    // Include native-only image paths that were not already listed.
    ...imagePaths.map((path) => ({
      path,
      kind: "image" as const,
    })),
  ];

  const effectivePrompt = appendAttachmentPathsToPrompt(prompt, promptAttachments);

  const imageInput = harness.imageInput ?? "path";
  if (imageInput === "native" && imagePaths.length > 0 && harness.buildImageArgs) {
    return { prompt: effectivePrompt, imageArgs: harness.buildImageArgs(imagePaths) };
  }

  return { prompt: effectivePrompt, imageArgs: [] };
}
