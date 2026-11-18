import { isAbsolute, resolve } from "path";
import { pathToFileURL } from "url";
import { selectPublishedArtifacts } from "./publication";
import { loadFilesArtifactUploader } from "./files-sdk-env";
import {
  isNativeArtifactUploader,
  loadNativeArtifactUploader,
} from "../code-host/native-artifact-uploader";
import type { RunArtifactRegistry } from "./registry";
import type { ArtifactPolicy, ArtifactUploader } from "./types";

export interface LoadedArtifactUploader {
  id: string;
  adapter: ArtifactUploader;
}

/** Resolve a trusted upload adapter before implementation, alongside pipeline plugins. */
export async function loadArtifactUploader(
  policy: ArtifactPolicy | undefined,
  baseDir: string,
): Promise<LoadedArtifactUploader | undefined> {
  const specifier = policy?.publish?.uploader;
  if (!specifier) return undefined;
  if (specifier === "files-sdk") return loadFilesArtifactUploader();
  // Native code-host hosting: destination and credentials come from the
  // checkout's origin remote and code-host configuration, resolved here so
  // cached URLs are scoped to that project.
  if (isNativeArtifactUploader(specifier)) return loadNativeArtifactUploader(specifier);
  const id =
    specifier.startsWith(".") || isAbsolute(specifier)
      ? resolve(baseDir, specifier)
      : Bun.resolveSync(specifier, baseDir);
  const module = (await import(pathToFileURL(id).href)) as { default?: ArtifactUploader };
  if (!module.default || typeof module.default.upload !== "function")
    throw new Error("Artifact uploader must default-export { upload(artifact, bytes) }");
  return { id, adapter: module.default };
}

/**
 * Only explicitly selected link/embed artifacts may leave the machine. Failures
 * remain advisory; when `failures` is supplied it receives a reason per key.
 */
export async function uploadSelectedArtifacts(
  registry: RunArtifactRegistry,
  policy: ArtifactPolicy | undefined,
  uploader: LoadedArtifactUploader | undefined,
  failures?: Map<string, string>,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (!policy?.publish || !uploader) return urls;
  const selections = policy.publish.select.filter(
    (entry) => entry.presentation === "embed" || entry.presentation === "link",
  );
  for (const artifact of selectPublishedArtifacts(registry, selections)) {
    try {
      let url = registry.uploadUrl(artifact.id, uploader.id);
      if (!url) {
        const bytes = registry.readBytes(artifact.id);
        if (!bytes) throw new Error("Artifact file expired or missing");
        const result = await uploader.adapter.upload(artifact, bytes);
        url = result.url;
        const parsed = new URL(url);
        if (
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          /[\s<>]/.test(url)
        )
          throw new Error("Uploader must return an HTTP(S) URL without credentials");
        registry.recordUpload(artifact.id, uploader.id, {
          url,
          remoteId: typeof result.remoteId === "string" ? result.remoteId : undefined,
          notice: typeof result.notice === "string" ? result.notice : undefined,
        });
        if (typeof result.notice === "string")
          console.log(`ℹ️  Artifact ${artifact.key} uploaded: ${result.notice}`);
      }
      urls.set(artifact.key, url.replace(/\(/g, "%28").replace(/\)/g, "%29"));
    } catch (error) {
      const message = (error as Error).message;
      registry.recordUpload(artifact.id, uploader.id, { error: message });
      failures?.set(artifact.key, message);
      console.warn(`⚠️ Artifact upload failed (${artifact.key}): ${message}`);
    }
  }
  return urls;
}
