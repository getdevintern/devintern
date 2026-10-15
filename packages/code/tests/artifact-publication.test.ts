import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunArtifactRegistry } from "../src/lib/artifacts/registry";
import {
  ARTIFACT_COMMENT_MARKER,
  buildArtifactComment,
  validateArtifactPolicy,
} from "../src/lib/artifacts/publication";
import { loadArtifactUploader, uploadSelectedArtifacts } from "../src/lib/artifacts/upload";
import type { ArtifactPolicy } from "../src/lib/artifacts/types";
import { upsertArtifactComment } from "../src/lib/code-host/github/artifact-comment";
import { GitHubPRClient } from "../src/lib/code-host/github/pr-client";

let dir: string;
let registry: RunArtifactRegistry;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifact-publication-"));
  registry = new RunArtifactRegistry(dir, dir, join(dir, "queue.db"));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
const policy: ArtifactPolicy = {
  publish: { destination: "pr-comment", select: [{ key: "explanation", presentation: "inline" }] },
};
async function capture(content: string, iteration = 1) {
  const path = join(dir, "explanation.md");
  writeFileSync(path, content);
  registry.beginStep("any-plugin-name", iteration);
  return (await registry.addFile({
    key: "explanation",
    path,
    title: "Explanation",
    kind: "explanation",
    mediaType: "text/markdown",
  }))!;
}
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("artifact publication policy", () => {
  test("publishes explicit selections from the latest execution", async () => {
    const old = await capture("old");
    const latest = await capture("latest", 2);
    expect(buildArtifactComment(registry, undefined)).toBeUndefined();
    const comment = buildArtifactComment(registry, policy)!;
    expect(comment.ids).toEqual([latest.id]);
    expect(comment.ids).not.toContain(old.id);
    expect(comment.body).toContain("latest");
    expect(comment.body).not.toContain("old");
    expect(comment.body).toContain("execution 2");
    expect(comment.body).toStartWith(ARTIFACT_COMMENT_MARKER);
  });
  test("validates policies before execution", () => {
    expect(() => validateArtifactPolicy(policy)).not.toThrow();
    expect(() =>
      validateArtifactPolicy({
        publish: { destination: "body", select: [] },
      } as unknown as ArtifactPolicy),
    ).toThrow();
    expect(() =>
      validateArtifactPolicy({
        publish: { ...policy.publish!, select: [{ key: "../escape", presentation: "inline" }] },
      }),
    ).toThrow();
    expect(() =>
      validateArtifactPolicy({
        publish: {
          ...policy.publish!,
          select: [policy.publish!.select[0]!, policy.publish!.select[0]!],
        },
      }),
    ).toThrow("Duplicate");
  });
  test("rewrites artifact references and bounds complete Markdown sections", async () => {
    await capture("![Screenshot](artifact:screen)");
    expect(buildArtifactComment(registry, policy)?.body).toContain(
      "Screenshot (artifact unavailable)",
    );
    expect(
      buildArtifactComment(
        registry,
        policy,
        new Map([["screen", "https://files.example/screen.png"]]),
      )?.body,
    ).toContain("![Screenshot](https://files.example/screen.png)");
    await capture("x".repeat(50_000), 2);
    expect(buildArtifactComment(registry, policy)!.body.length).toBeLessThan(45_000);
    expect(buildArtifactComment(registry, policy)!.body).toContain("preview budget");
  });
  test("uploads selected files once and reuses persisted URLs", async () => {
    await capture("explanation");
    const path = join(dir, "screen.png");
    writeFileSync(path, Buffer.from([137, 80, 78, 71]));
    await registry.addFile({
      key: "screen",
      path,
      title: "Screenshot",
      kind: "image",
      mediaType: "image/png",
    });
    const selected: ArtifactPolicy = {
      publish: {
        destination: "pr-comment",
        select: [...policy.publish!.select, { key: "screen", presentation: "embed" }],
      },
    };
    let calls = 0;
    const uploader = {
      id: "test-uploader",
      adapter: {
        upload: async (artifact: { key: string }) => {
          calls++;
          expect(artifact.key).toBe("screen");
          return { url: "https://files.example/screen.png" };
        },
      },
    };
    const urls = await uploadSelectedArtifacts(registry, selected, uploader);
    expect(urls.get("screen")).toBe("https://files.example/screen.png");
    await uploadSelectedArtifacts(registry, selected, uploader);
    expect(calls).toBe(1);
    expect(buildArtifactComment(registry, selected, urls)?.body).toContain(
      "![Screenshot](https://files.example/screen.png)",
    );
  });
  test("invalid upload URLs remain advisory", async () => {
    await capture("text");
    const selected: ArtifactPolicy = {
      publish: {
        destination: "pr-comment",
        select: [{ key: "explanation", presentation: "link" }],
      },
    };
    const urls = await uploadSelectedArtifacts(registry, selected, {
      id: "bad",
      adapter: { upload: async () => ({ url: "javascript:alert(1)" }) },
    });
    expect(urls.size).toBe(0);
    expect(buildArtifactComment(registry, selected, urls)?.body).toContain("no upload URL");
  });
  test("loads a pipeline-relative uploader and rejects invalid exports", async () => {
    writeFileSync(
      join(dir, "upload.ts"),
      'export default { upload: async () => ({ url: "https://files.example/file" }) };',
    );
    expect(
      (
        await loadArtifactUploader(
          { publish: { ...policy.publish!, uploader: "./upload.ts" } },
          dir,
        )
      )?.id,
    ).toBe(join(dir, "upload.ts"));
    writeFileSync(join(dir, "invalid.ts"), "export default {};");
    await expect(
      loadArtifactUploader({ publish: { ...policy.publish!, uploader: "./invalid.ts" } }, dir),
    ).rejects.toThrow("default-export");
  });
});

describe("managed GitHub artifact comment", () => {
  test("updates its author's comment across pages", async () => {
    globalThis.fetch = (async (url, init) => {
      const address = String(url);
      if (address.endsWith("/user")) return json({ login: "devintern-bot" });
      if (new URL(address).searchParams.get("page") === "1")
        return json(
          Array.from({ length: 100 }, (_, i) => ({
            id: i,
            body: ARTIFACT_COMMENT_MARKER,
            user: { login: "someone-else" },
          })),
        );
      if (new URL(address).searchParams.get("page") === "2")
        return json([
          { id: 123, body: `${ARTIFACT_COMMENT_MARKER}\nold`, user: { login: "devintern-bot" } },
        ]);
      expect(init?.method).toBe("PATCH");
      expect(address).toEndWith("/issues/comments/123");
      return json({ id: 123, html_url: "https://github.com/o/r/pull/1#issuecomment-123" });
    }) as typeof fetch;
    const result = await upsertArtifactComment({
      token: "test",
      baseUrl: "https://api.github.com",
      repository: "o/r",
      number: 1,
      body: `${ARTIFACT_COMMENT_MARKER}\nnew`,
    });
    expect(result.status).toBe("published");
    expect(result.commentId).toBe(123);
  });
  test("supports App identity without the user endpoint", async () => {
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).not.toEndWith("/user");
      return init?.method === "POST"
        ? json({ id: 1, html_url: "https://github.com/o/r/pull/1#issuecomment-1" })
        : json([]);
    }) as typeof fetch;
    expect(
      (
        await upsertArtifactComment({
          token: "app",
          authorLogin: "devintern[bot]",
          baseUrl: "https://api.github.com",
          repository: "o/r",
          number: 1,
          body: ARTIFACT_COMMENT_MARKER,
        })
      ).status,
    ).toBe("published");
  });
  test("publication failure preserves successful PR creation", async () => {
    globalThis.fetch = (async (url) =>
      String(url).endsWith("/pulls")
        ? json({ number: 7, html_url: "https://github.com/o/r/pull/7" }, 201)
        : json({ message: "Forbidden" }, 403)) as typeof fetch;
    const result = await new GitHubPRClient("test").createPullRequest({
      title: "Task",
      body: "PR body",
      sourceBranch: "feature",
      targetBranch: "main",
      repository: "o/r",
      artifactComment: ARTIFACT_COMMENT_MARKER,
    });
    expect(result.success).toBe(true);
    expect(result.artifactPublication?.status).toBe("failed");
    expect(result.warnings?.length).toBe(1);
  });
  test("publishes evidence when create discovers an existing PR", async () => {
    let updated = false;
    globalThis.fetch = (async (url, init) => {
      const address = String(url);
      if (address.endsWith("/pulls")) return json({ message: "exists" }, 422);
      if (address.includes("/pulls?")) return json([{ html_url: "https://github.com/o/r/pull/7" }]);
      if (address.endsWith("/user")) return json({ login: "bot" });
      if (init?.method === "POST") {
        updated = true;
        return json({ id: 77, html_url: "https://github.com/o/r/pull/7#issuecomment-77" });
      }
      return json([]);
    }) as typeof fetch;
    const result = await new GitHubPRClient("test").createPullRequest({
      title: "Task",
      body: "PR body",
      sourceBranch: "feature",
      targetBranch: "main",
      repository: "o/r",
      artifactComment: ARTIFACT_COMMENT_MARKER,
    });
    expect(result.success).toBe(true);
    expect(updated).toBe(true);
    expect(result.artifactPublication?.commentId).toBe(77);
  });
});
