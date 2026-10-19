import { createHash } from "node:crypto";
import type { Files } from "files-sdk";
import type { ArtifactUploader } from "./types";

export interface FilesArtifactUploaderOptions {
  /** Configured Files SDK instance. Keep its prefix empty; use keyPrefix below. */
  files: Pick<Files, "upload">;
  /** Durable HTTP(S) origin/path serving the storage root, without signed query parameters. */
  publicBaseUrl: string;
  /** Storage namespace, relative to that root. Defaults to devintern/artifacts. */
  keyPrefix?: string;
  /** Total upload deadline, including retries. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** Bridge any configured Files SDK backend to pipeline artifact publication. */
export function createFilesArtifactUploader(
  options: FilesArtifactUploaderOptions,
): ArtifactUploader {
  const base = new URL(options.publicBaseUrl);
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      "Artifact publicBaseUrl must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const prefix = options.keyPrefix ?? "devintern/artifacts";
  if (prefix && !prefix.split("/").every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part))) {
    throw new Error("Artifact keyPrefix must contain safe, relative path segments");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("Artifact timeoutMs must be an integer between 1 and 300000");
  }
  if (typeof options.files?.upload !== "function") {
    throw new Error("Artifact files must be a configured Files SDK instance");
  }

  return {
    async upload(artifact, bytes) {
      // Include MIME and a sanitized filename: identical bytes with different
      // content types must not overwrite each other's response headers.
      const digest = createHash("sha256")
        .update(artifact.mediaType)
        .update("\0")
        .update(bytes)
        .digest("hex");
      const cleanedName = artifact.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
      const name = !cleanedName || /^\.{1,2}$/.test(cleanedName) ? "artifact" : cleanedName;
      const key = [prefix, digest, name].filter(Boolean).join("/");
      await options.files.upload(key, bytes, {
        contentType: artifact.mediaType,
        signal: AbortSignal.timeout(timeoutMs),
        timeout: timeoutMs,
        retries: 2,
      });
      return { url: new URL(key.split("/").map(encodeURIComponent).join("/"), base).href };
    },
  };
}
