/**
 * Attachment allowlist, validation, and temp staging for story generation.
 */

import { copyFile, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { isImagePath } from "@devintern/agent-harness";
import { mkdir, pathExists, rm } from "./runtime/fs.js";

/** Max files a user may attach to one generate/create. */
export const MAX_ATTACHMENTS = 10;

/** Max size per attachment (10 MiB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".log",
  ".pdf",
  ".ipynb",
]);

const REJECTED_OFFICE = new Set([
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
  ".zip",
  ".dmg",
  ".exe",
]);

export interface AttachmentRef {
  path: string;
  name?: string;
}

export interface StagedAttachment {
  path: string;
  name: string;
  kind: "image" | "file";
}

/**
 * Return true when the file extension is on the v1 allowlist.
 *
 * @param filename - File name or path.
 */
export function isAllowedAttachmentExtension(filename: string): boolean {
  return ALLOWED_EXTENSIONS.has(extname(filename).toLowerCase());
}

/**
 * Human-readable rejection reason, or `null` when the path is acceptable.
 *
 * Does not check existence or size — use {@link validateAttachmentFile} for that.
 *
 * @param filename - File name or path (extension only).
 */
export function attachmentExtensionError(filename: string): string | null {
  const ext = extname(filename).toLowerCase();
  if (!ext) {
    return "File has no extension";
  }
  if (REJECTED_OFFICE.has(ext)) {
    return `${ext} files are not supported — export to .md, .txt, or .pdf instead`;
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `Unsupported file type ${ext}`;
  }
  return null;
}

/**
 * Validate a local attachment path (exists, size, extension).
 *
 * @param filePath - Absolute path to a local file.
 * @param name - Optional display name used in errors.
 * @throws When the file is missing, oversized, or disallowed.
 */
export async function validateAttachmentFile(filePath: string, name?: string): Promise<void> {
  const label = name || basename(filePath);
  const extError = attachmentExtensionError(label);
  if (extError) {
    throw new Error(`${label}: ${extError}`);
  }
  if (!(await pathExists(filePath))) {
    throw new Error(`${label}: file not found (${filePath})`);
  }
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`${label}: not a regular file`);
  }
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${label}: exceeds ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB limit`);
  }
}

/**
 * Sanitize a filename for staging (keep extension, strip path separators).
 *
 * @param name - Original filename.
 */
export function sanitizeAttachmentFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.length > 0 ? base : "attachment";
}

/**
 * Copy attachments into a temp directory for the agent run.
 *
 * @param attachments - Source file refs (absolute paths).
 * @returns Staging directory and staged file metadata.
 */
export async function stageAttachments(attachments: readonly AttachmentRef[]): Promise<{
  dir: string;
  files: StagedAttachment[];
}> {
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS})`);
  }

  const dir = await mkdtemp(join(tmpdir(), "devpm-attachments-"));
  await mkdir(dir);

  const usedNames = new Set<string>();
  const files: StagedAttachment[] = [];

  for (const attachment of attachments) {
    await validateAttachmentFile(attachment.path, attachment.name);
    let name = sanitizeAttachmentFilename(attachment.name || basename(attachment.path));
    if (usedNames.has(name)) {
      const ext = extname(name);
      const stem = ext ? name.slice(0, -ext.length) : name;
      let i = 2;
      while (usedNames.has(`${stem}-${i}${ext}`)) {
        i += 1;
      }
      name = `${stem}-${i}${ext}`;
    }
    usedNames.add(name);

    const dest = join(dir, name);
    await copyFile(attachment.path, dest);
    files.push({
      path: dest,
      name,
      kind: isImagePath(name) ? "image" : "file",
    });
  }

  return { dir, files };
}

/**
 * Best-effort cleanup of a staging directory.
 *
 * @param dir - Directory previously returned by {@link stageAttachments}.
 */
export async function cleanupAttachmentStaging(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await rm(dir);
  } catch {
    // ignore
  }
}

/**
 * Short prompt blurb when attachments are present (paths are injected by the harness).
 */
export function attachmentsGuidanceBlurb(hasAttachments: boolean): string {
  if (!hasAttachments) {
    return "";
  }
  return (
    "\nAdditional context files are attached locally — open and read them before drafting. " +
    "Do not invent content that contradicts the attachments.\n"
  );
}
