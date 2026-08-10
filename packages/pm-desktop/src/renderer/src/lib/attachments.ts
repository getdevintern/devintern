/**
 * Renderer-side attachment helpers (allowlist mirroring @getdevintern/pm/attachments).
 */

import type { AttachmentRef } from "../../../shared/ipc-contract.ts";

export const MAX_COMPOSER_ATTACHMENTS = 10;

const ALLOWED = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "log",
  "pdf",
  "ipynb",
]);

const REJECTED_HINT = new Set(["docx", "doc", "xlsx", "xls", "pptx", "ppt", "zip", "dmg", "exe"]);

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

/** True when the filename looks like an image. */
export function isImageAttachmentName(name: string): boolean {
  return ["png", "jpg", "jpeg", "webp", "gif"].includes(extensionOf(name));
}

/**
 * Rejection reason for a filename, or null when allowed.
 *
 * @param name - Display filename.
 */
export function attachmentRejectReason(name: string): string | null {
  const ext = extensionOf(name);
  if (!ext) return "File has no extension";
  if (REJECTED_HINT.has(ext)) {
    return `${ext} files are not supported — export to .md, .txt, or .pdf instead`;
  }
  if (!ALLOWED.has(ext)) {
    return `Unsupported file type .${ext}`;
  }
  return null;
}

/**
 * Merge new refs into existing attachments with cap + allowlist filtering.
 *
 * @returns Next list and optional error message for rejected items.
 */
export function mergeAttachments(
  current: AttachmentRef[],
  incoming: AttachmentRef[],
): { next: AttachmentRef[]; error: string | null } {
  const seen = new Set(current.map((a) => a.path));
  const next = [...current];
  const errors: string[] = [];

  for (const ref of incoming) {
    if (seen.has(ref.path)) continue;
    const reason = attachmentRejectReason(ref.name);
    if (reason) {
      errors.push(`${ref.name}: ${reason}`);
      continue;
    }
    if (next.length >= MAX_COMPOSER_ATTACHMENTS) {
      errors.push(`Maximum ${MAX_COMPOSER_ATTACHMENTS} attachments`);
      break;
    }
    seen.add(ref.path);
    next.push(ref);
  }

  return { next, error: errors[0] ?? null };
}
