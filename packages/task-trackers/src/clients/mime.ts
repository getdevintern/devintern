/**
 * Lightweight extension → MIME map for attachment uploads.
 * Unknown extensions fall back to application/octet-stream.
 */

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".log": "text/plain",
  ".pdf": "application/pdf",
  ".ipynb": "application/x-ipynb+json",
};

/**
 * Guess a MIME type from a filename or path.
 *
 * @param filename - File name or path.
 * @returns MIME type string.
 */
export function mimeTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return "application/octet-stream";
  }
  return MIME_BY_EXT[lower.slice(dot)] ?? "application/octet-stream";
}
