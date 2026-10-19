import { createHash } from "node:crypto";
import { createFilesArtifactUploader } from "./files-sdk-uploader";
import type { ArtifactUploader } from "./types";

/** Explicitly selected storage backend for the built-in Files SDK uploader. */
export function filesArtifactStorageConfig(env: Record<string, string | undefined>) {
  const read = (key: string) => env[key]?.trim() || undefined;
  const required = (key: string) => {
    const value = read(key);
    if (!value) throw new Error(`Set ${key} for the files-sdk artifact uploader`);
    return value;
  };
  const provider = required("DEVINTERN_ARTIFACT_PROVIDER");
  if (provider !== "r2" && provider !== "s3") {
    throw new Error(
      "DEVINTERN_ARTIFACT_PROVIDER must be r2 or s3; use a custom module for other Files SDK backends",
    );
  }
  const accountId = provider === "r2" ? required("DEVINTERN_ARTIFACT_ACCOUNT_ID") : undefined;
  if (accountId && !/^[a-fA-F0-9]{32}$/.test(accountId)) {
    throw new Error("DEVINTERN_ARTIFACT_ACCOUNT_ID must be the 32-character Cloudflare account ID");
  }
  return {
    provider,
    bucket: required("DEVINTERN_ARTIFACT_BUCKET"),
    publicBaseUrl: required("DEVINTERN_ARTIFACT_PUBLIC_BASE_URL"),
    keyPrefix: read("DEVINTERN_ARTIFACT_KEY_PREFIX") ?? "devintern/artifacts",
    endpoint:
      provider === "r2"
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : read("DEVINTERN_ARTIFACT_ENDPOINT"),
    region: provider === "r2" ? "auto" : (read("DEVINTERN_ARTIFACT_REGION") ?? "us-east-1"),
    // These belong to artifact storage; do not accidentally reuse another service's credentials.
    accessKeyId: required("DEVINTERN_ARTIFACT_ACCESS_KEY_ID"),
    secretAccessKey: required("DEVINTERN_ARTIFACT_SECRET_ACCESS_KEY"),
  };
}

/** Built-in R2/S3 target, validated before implementation and connected lazily. */
export function loadFilesArtifactUploader(env: Record<string, string | undefined> = process.env): {
  id: string;
  adapter: ArtifactUploader;
} {
  const config = filesArtifactStorageConfig(env);
  // Changing the destination must not reuse an earlier target's persisted URLs.
  const id = `files-sdk:${createHash("sha256")
    .update(
      JSON.stringify({
        provider: config.provider,
        bucket: config.bucket,
        endpoint: config.endpoint,
        region: config.region,
        publicBaseUrl: config.publicBaseUrl,
        keyPrefix: config.keyPrefix,
      }),
    )
    .digest("hex")}`;
  let storage: Promise<import("files-sdk").Files> | undefined;
  const adapter = createFilesArtifactUploader({
    publicBaseUrl: config.publicBaseUrl,
    keyPrefix: config.keyPrefix,
    files: {
      async upload(...args: unknown[]) {
        storage ??= Promise.all([import("files-sdk"), import("files-sdk/bun-s3")]).then(
          ([{ Files }, { bunS3 }]) =>
            new Files({
              adapter: bunS3({
                bucket: config.bucket,
                endpoint: config.endpoint,
                region: config.region,
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
              }),
            }),
        );
        const files = await storage;
        // Preserve Files SDK's overloaded API on this lazy forwarding facade.
        return Reflect.apply(files.upload, files, args);
      },
    } as Parameters<typeof createFilesArtifactUploader>[0]["files"],
  });
  return { id, adapter };
}
