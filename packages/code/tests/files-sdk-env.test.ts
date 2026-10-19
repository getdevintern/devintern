import { afterEach, describe, expect, test } from "bun:test";
import {
  filesArtifactStorageConfig,
  loadFilesArtifactUploader,
} from "../src/lib/artifacts/files-sdk-env";
import { loadArtifactUploader } from "../src/lib/artifacts/upload";

const env = {
  DEVINTERN_ARTIFACT_PROVIDER: "r2",
  DEVINTERN_ARTIFACT_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  DEVINTERN_ARTIFACT_BUCKET: "reviews",
  DEVINTERN_ARTIFACT_PUBLIC_BASE_URL: "https://artifacts.example.com/",
  DEVINTERN_ARTIFACT_ACCESS_KEY_ID: "test-key",
  DEVINTERN_ARTIFACT_SECRET_ACCESS_KEY: "test-secret",
};
const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith("DEVINTERN_ARTIFACT_")) delete process.env[key];
  for (const [key, value] of Object.entries(original))
    if (key.startsWith("DEVINTERN_ARTIFACT_")) process.env[key] = value;
});

describe("built-in Files SDK storage", () => {
  test("derives Cloudflare endpoint and auto region without code or endpoint settings", () => {
    const config = filesArtifactStorageConfig({
      ...env,
      DEVINTERN_ARTIFACT_REGION: "ignored",
      DEVINTERN_ARTIFACT_ENDPOINT: "https://ignored.example",
    });
    expect(config.endpoint).toBe(
      `https://${env.DEVINTERN_ARTIFACT_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    );
    expect(config.region).toBe("auto");
    expect(config.bucket).toBe("reviews");
    expect(config.accessKeyId).toBe("test-key");
    expect(config.secretAccessKey).toBe("test-secret");
  });

  test("supports AWS S3 and custom S3-compatible endpoints", () => {
    const config = filesArtifactStorageConfig({
      ...env,
      DEVINTERN_ARTIFACT_PROVIDER: "s3",
      DEVINTERN_ARTIFACT_REGION: "eu-west-1",
      DEVINTERN_ARTIFACT_ENDPOINT: "https://storage.example",
    });
    expect(config.endpoint).toBe("https://storage.example");
    expect(config.region).toBe("eu-west-1");
    expect(
      filesArtifactStorageConfig({ ...env, DEVINTERN_ARTIFACT_PROVIDER: "s3" }).endpoint,
    ).toBeUndefined();
  });

  test("rejects incomplete or unknown targets before implementation", () => {
    for (const key of Object.keys(env)) {
      expect(() => loadFilesArtifactUploader({ ...env, [key]: "" })).toThrow(key);
    }
    expect(() => loadFilesArtifactUploader({ ...env, DEVINTERN_ARTIFACT_PROVIDER: "gcs" })).toThrow(
      "r2 or s3",
    );
    expect(() =>
      loadFilesArtifactUploader({ ...env, DEVINTERN_ARTIFACT_ACCOUNT_ID: "not/an/account" }),
    ).toThrow("32-character");
    expect(() =>
      loadFilesArtifactUploader({ ...env, DEVINTERN_ARTIFACT_PUBLIC_BASE_URL: "file:///tmp" }),
    ).toThrow("HTTP(S)");
  });

  test("cache identity follows the target and excludes rotated credentials", () => {
    const first = loadFilesArtifactUploader(env);
    expect(
      loadFilesArtifactUploader({ ...env, DEVINTERN_ARTIFACT_SECRET_ACCESS_KEY: "rotated" }).id,
    ).toBe(first.id);
    for (const changed of [
      { DEVINTERN_ARTIFACT_BUCKET: "other" },
      { DEVINTERN_ARTIFACT_PUBLIC_BASE_URL: "https://new.example/" },
      { DEVINTERN_ARTIFACT_KEY_PREFIX: "other" },
    ]) {
      expect(loadFilesArtifactUploader({ ...env, ...changed }).id).not.toBe(first.id);
    }
    expect(first.id).not.toContain("test-secret");
  });

  test("pipeline resolves the built-in without importing a user module", async () => {
    Object.assign(process.env, env);
    const loaded = await loadArtifactUploader(
      {
        publish: {
          destination: "pr-comment",
          uploader: "files-sdk",
          select: [{ key: "image", presentation: "embed" }],
        },
      },
      "/not-a-project",
    );
    expect(loaded?.id).toStartWith("files-sdk:");
    expect(typeof loaded?.adapter.upload).toBe("function");
  });
});
