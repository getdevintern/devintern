import { isAbsolute, resolve } from "path";
import { pathToFileURL } from "url";
import { selectPublishedArtifacts } from "./publication";
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
  const id =
    specifier.startsWith(".") || isAbsolute(specifier)
      ? resolve(baseDir, specifier)
      : Bun.resolveSync(specifier, baseDir);
  const module = (await import(pathToFileURL(id).href)) as { default?: ArtifactUploader };
  if (!module.default || typeof module.default.upload !== "function")
    throw new Error("Artifact uploader must default-export { upload(artifact, bytes) }");
  return { id, adapter: module.default };
}

/** Only explicitly selected link/embed artifacts may leave the machine. Failures remain advisory. */
export async function uploadSelectedArtifacts(
  registry: RunArtifactRegistry,
  policy: ArtifactPolicy | undefined,
  uploader: LoadedArtifactUploader | undefined,
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
        url = (await uploader.adapter.upload(artifact, bytes)).url;
        const parsed = new URL(url);
        if (
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          /[\s<>]/.test(url)
        )
          throw new Error("Uploader must return an HTTP(S) URL without credentials");
        registry.recordUpload(artifact.id, uploader.id, { url });
      }
      urls.set(artifact.key, url.replace(/\(/g, "%28").replace(/\)/g, "%29"));
    } catch (error) {
      const message = (error as Error).message;
      registry.recordUpload(artifact.id, uploader.id, { error: message });
      console.warn(`⚠️ Artifact upload failed (${artifact.key}): ${message}`);
    }
  }
  return urls;
}
