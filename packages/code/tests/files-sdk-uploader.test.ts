import { describe, expect, test } from "bun:test";
import { createFilesArtifactUploader } from "../src/lib/artifacts/files-sdk-uploader";
import type { FilesArtifactUploaderOptions } from "../src/lib/artifacts/files-sdk-uploader";
import type { RunArtifact } from "../src/lib/artifacts/types";

const artifact: RunArtifact = {
  id: "image-1",
  key: "explanation-image",
  runId: null,
  step: "explain",
  iteration: 1,
  name: "review image.png",
  title: "Review image",
  kind: "image",
  mediaType: "image/png",
  size: 3,
  checksum: "ignored-in-favor-of-actual-bytes",
  createdAt: 1,
  available: true,
};

/** Isolated storage double; never calls a provider. */
function storage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const calls: Array<{ key: string; signal: AbortSignal; timeout: number; retries: number }> = [];
  const files = {
    async upload(
      key: string,
      bytes: Uint8Array,
      options: { contentType?: string; signal: AbortSignal; timeout: number; retries: number },
    ) {
      objects.set(key, { bytes: bytes.slice(), contentType: options.contentType });
      calls.push({ key, ...options });
      return {};
    },
  } as unknown as FilesArtifactUploaderOptions["files"];
  return { files, objects, calls };
}

describe("Files SDK artifact uploader", () => {
  test("uploads MIME-typed bytes at a stable key and returns a durable URL", async () => {
    const { files, objects, calls } = storage();
    const uploader = createFilesArtifactUploader({
      files,
      publicBaseUrl: "https://cdn.example/assets",
      keyPrefix: "reviews/project",
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await uploader.upload(artifact, bytes);
    const key = calls[0].key;
    expect(key).toMatch(/^reviews\/project\/[a-f0-9]{64}\/review_image.png$/);
    expect(result.url).toBe(`https://cdn.example/assets/${key}`);
    expect(objects.get(key)).toEqual({ bytes, contentType: "image/png" });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].timeout).toBe(30_000);
    expect(calls[0].retries).toBe(2);
    expect(await uploader.upload({ ...artifact, id: "new-run" }, bytes)).toEqual(result);
    expect(objects.size).toBe(1);
    expect(await uploader.upload(artifact, new Uint8Array([4]))).not.toEqual(result);
    expect(
      await uploader.upload({ ...artifact, mediaType: "application/octet-stream" }, bytes),
    ).not.toEqual(result);
    expect(objects.size).toBe(3);
  });

  test("accepts arbitrary file types and sanitizes path-like filenames", async () => {
    const { files, calls } = storage();
    const uploader = createFilesArtifactUploader({
      files,
      publicBaseUrl: "https://cdn.example/",
      keyPrefix: "",
    });
    const result = await uploader.upload(
      { ...artifact, name: "../../report #1.zip", mediaType: "application/zip" },
      new Uint8Array([1]),
    );
    expect(calls[0].key.split("/")).toHaveLength(2);
    expect(new URL(result.url).pathname).toContain("report__1.zip");
  });

  test("dot filenames cannot normalize the returned URL to another object", async () => {
    const { files, calls } = storage();
    const uploader = createFilesArtifactUploader({ files, publicBaseUrl: "https://cdn.example/" });
    for (const name of [".", "..", ""]) {
      const { url } = await uploader.upload({ ...artifact, name }, new Uint8Array([1]));
      expect(url).toBe(`https://cdn.example/${calls.at(-1)!.key}`);
      expect(url).toEndWith("/artifact");
    }
  });

  test("rejects invalid settings before uploading", () => {
    const { files, calls } = storage();
    for (const publicBaseUrl of [
      "file:///tmp/x",
      "https://user:secret@cdn.example",
      "https://cdn.example?token=x",
      "https://cdn.example#x",
    ]) {
      expect(() => createFilesArtifactUploader({ files, publicBaseUrl })).toThrow();
    }
    for (const keyPrefix of ["../escape", "/absolute", "a//b", "a/../b"]) {
      expect(() =>
        createFilesArtifactUploader({ files, publicBaseUrl: "https://cdn.example", keyPrefix }),
      ).toThrow("keyPrefix");
    }
    for (const timeoutMs of [0, -1, 1.5, 300_001]) {
      expect(() =>
        createFilesArtifactUploader({ files, publicBaseUrl: "https://cdn.example", timeoutMs }),
      ).toThrow("timeoutMs");
    }
    expect(calls).toHaveLength(0);
  });

  test("propagates storage errors to the advisory publication handler", async () => {
    const { files } = storage();
    files.upload = async () => {
      throw new Error("storage unavailable");
    };
    await expect(
      createFilesArtifactUploader({ files, publicBaseUrl: "https://cdn.example" }).upload(
        artifact,
        new Uint8Array(),
      ),
    ).rejects.toThrow("storage unavailable");
  });
});
