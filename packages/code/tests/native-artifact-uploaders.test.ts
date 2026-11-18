import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunArtifactRegistry } from "../src/lib/artifacts/registry";
import { ARTIFACT_COMMENT_MARKER, buildArtifactComment } from "../src/lib/artifacts/publication";
import { uploadSelectedArtifacts } from "../src/lib/artifacts/upload";
import type { ArtifactPolicy, RunArtifact } from "../src/lib/artifacts/types";
import {
  classifyGitHubToken,
  createGitHubAttachmentUploader,
} from "../src/lib/code-host/github/attachment-uploader";
import { GitLabApi } from "../src/lib/code-host/gitlab/api";
import { upsertArtifactNote } from "../src/lib/code-host/gitlab/artifact-note";
import { GitLabMRClient } from "../src/lib/code-host/gitlab/mr-client";
import {
  createGitLabUploadAdapter,
  gitLabMediaAccessNotice,
  isGitLabUploadLinkPublic,
  normalizeGitLabUploadUrl,
} from "../src/lib/code-host/gitlab/upload-adapter";
import { loadNativeArtifactUploader } from "../src/lib/code-host/native-artifact-uploader";

let dir: string;
let registry: RunArtifactRegistry;
const originalFetch = globalThis.fetch;
const originalRetries = process.env.DEVINTERN_FETCH_MAX_RETRIES;
const json = (body: unknown, status = 200) => Response.json(body, { status });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "native-artifact-uploaders-"));
  registry = new RunArtifactRegistry(dir, dir, join(dir, "queue.db"));
  // 429/5xx responses must surface immediately instead of backing off.
  process.env.DEVINTERN_FETCH_MAX_RETRIES = "0";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRetries === undefined) delete process.env.DEVINTERN_FETCH_MAX_RETRIES;
  else process.env.DEVINTERN_FETCH_MAX_RETRIES = originalRetries;
  rmSync(dir, { recursive: true, force: true });
});

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const artifact = (overrides: Partial<RunArtifact> = {}): RunArtifact => ({
  id: "00000000-0000-0000-0000-000000000000",
  key: "screen",
  title: "Screenshot",
  kind: "image",
  mediaType: "image/png",
  runId: 1,
  step: "screenshot",
  iteration: 1,
  name: "screen.png",
  size: png.byteLength,
  checksum: "x",
  createdAt: 0,
  available: true,
  ...overrides,
});
async function captureScreenshot() {
  const path = join(dir, "screen.png");
  writeFileSync(path, png);
  registry.beginStep("screenshot", 1);
  return (await registry.addFile({
    key: "screen",
    path,
    title: "Screenshot",
    kind: "image",
    mediaType: "image/png",
  }))!;
}
const embedPolicy: ArtifactPolicy = {
  publish: { destination: "pr-comment", select: [{ key: "screen", presentation: "embed" }] },
};

describe("native GitHub attachments", () => {
  test("classifies token types, keeping App user and installation tokens apart", () => {
    expect(classifyGitHubToken("gho_x")).toBe("oauth");
    expect(classifyGitHubToken("ghp_x")).toBe("personal-classic");
    expect(classifyGitHubToken("github_pat_x")).toBe("personal-fine-grained");
    expect(classifyGitHubToken("ghu_x")).toBe("app-user");
    expect(classifyGitHubToken("ghs_x")).toBe("app-installation");
    expect(classifyGitHubToken("legacy")).toBe("unknown");
  });

  test("uploads raw bytes with the repository ID and returns the attachment URL", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url) === "https://api.github.com/repos/o/r")
        return json({ id: 42, permissions: { push: true } });
      return json({ url: "https://github.com/user-attachments/assets/abc" }, 201);
    }) as typeof fetch;
    const uploader = createGitHubAttachmentUploader({ token: "ghp_test", repository: "o/r" });
    const result = await uploader.upload(artifact(), png);
    expect(result.url).toBe("https://github.com/user-attachments/assets/abc");
    await uploader.upload(artifact(), png);
    // Repository lookup is memoized; no comment endpoints are touched.
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/repos/o/r",
      "/user-attachments/assets",
      "/user-attachments/assets",
    ]);
    const upload = new URL(requests[1]!.url);
    expect(upload.origin).toBe("https://uploads.github.com");
    expect(upload.searchParams.get("repository_id")).toBe("42");
    expect(upload.searchParams.get("name")).toBe("screen.png");
    expect(upload.searchParams.get("content_type")).toBe("image/png");
    expect(requests[1]!.init?.method).toBe("POST");
    const headers = requests[1]!.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers.Authorization).toBe("Bearer ghp_test");
    expect(requests[1]!.init?.body).toBe(png);
  });

  test("rejects read-only tokens, unsupported media, and oversized images before uploading", async () => {
    let uploads = 0;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("/repos/")) return json({ id: 1, permissions: { pull: true } });
      uploads++;
      return json({ url: "https://example.invalid" });
    }) as typeof fetch;
    const uploader = createGitHubAttachmentUploader({ token: "gho_test", repository: "o/r" });
    await expect(uploader.upload(artifact(), png)).rejects.toThrow("write access");
    await expect(
      uploader.upload(artifact({ mediaType: "image/webp", name: "x.webp" }), png),
    ).rejects.toThrow("do not accept image/webp");
    await expect(uploader.upload(artifact(), new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow(
      "GitHub allows 10 MB",
    );
    expect(uploads).toBe(0);
  });

  test("maps upload API failures to actionable messages", async () => {
    let status = 404;
    globalThis.fetch = (async (url) =>
      String(url).includes("/repos/")
        ? json({ id: 1 })
        : status === 422
          ? json({ message: "bad\nextension" }, 422)
          : new Response("", { status, headers: { "Retry-After": "30" } })) as typeof fetch;
    const uploader = createGitHubAttachmentUploader({ token: "ghu_user", repository: "o/r" });
    await expect(uploader.upload(artifact(), png)).rejects.toThrow("require write access");
    status = 422;
    await expect(uploader.upload(artifact(), png)).rejects.toThrow("bad; extension");
    status = 429;
    await expect(uploader.upload(artifact(), png)).rejects.toThrow("retry after 30 seconds");
  });

  test("reports installation tokens, App-only auth, and unsupported hosts without uploading", async () => {
    let calls = 0;
    globalThis.fetch = (async (_url: string | URL | Request) => {
      calls++;
      return json({});
    }) as typeof fetch;
    const remoteUrl = "git@github.com:o/r.git";
    const installation = loadNativeArtifactUploader("github", {
      remoteUrl,
      env: { GITHUB_TOKEN: "ghs_install" },
    });
    expect(installation.id).toBe("native-github:https://github.com/o/r");
    await expect(installation.adapter.upload(artifact(), png)).rejects.toThrow(
      "installation tokens",
    );
    const appOnly = loadNativeArtifactUploader("github", {
      remoteUrl,
      env: { GITHUB_APP_ID: "1" },
    });
    await expect(appOnly.adapter.upload(artifact(), png)).rejects.toThrow("installation tokens");
    const enterprise = loadNativeArtifactUploader("github", {
      remoteUrl: "https://github.example.com/o/r.git",
      env: { GITHUB_TOKEN: "ghp_x" },
    });
    await expect(enterprise.adapter.upload(artifact(), png)).rejects.toThrow(
      "GitHub Enterprise Server is not supported",
    );
    const mismatch = loadNativeArtifactUploader("github", {
      remoteUrl: "https://gitlab.com/g/p.git",
      env: { GITHUB_TOKEN: "ghp_x" },
    });
    await expect(mismatch.adapter.upload(artifact(), png)).rejects.toThrow(
      "origin points to gitlab",
    );
    expect(calls).toBe(0);
  });

  test("code-host picks the origin's provider and scopes the cache id per project", () => {
    const env = {
      GITHUB_TOKEN: "ghp_x",
      DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
      GITLAB_CODE_HOST_URL: "https://git.example.com/gitlab",
      GITLAB_CODE_HOST_TOKEN: "glpat",
    };
    expect(
      loadNativeArtifactUploader("code-host", { remoteUrl: "git@github.com:o/r.git", env }).id,
    ).toBe("native-github:https://github.com/o/r");
    expect(
      loadNativeArtifactUploader("code-host", {
        remoteUrl: "https://git.example.com/gitlab/group/sub/proj.git",
        env,
      }).id,
    ).toBe("native-gitlab:https://git.example.com/gitlab/group/sub/proj");
  });

  test("an unreadable GitLab CA file stays advisory instead of throwing", async () => {
    const env = {
      DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST: "true",
      GITLAB_CODE_HOST_TOKEN: "x",
      GITLAB_CODE_HOST_CA_FILE: join(tmpdir(), "devintern-missing-ca", "ca.pem"),
    };
    const loaded = loadNativeArtifactUploader("gitlab", {
      remoteUrl: "https://gitlab.com/g/p.git",
      env,
    });
    expect(loaded.id).toBe("native-gitlab:https://gitlab.com/g/p");
    await expect(loaded.adapter.upload(artifact(), png)).rejects.toThrow(
      "Cannot read GITLAB_CODE_HOST_CA_FILE",
    );
  });
});

describe("native GitLab uploads", () => {
  test("normalizes upload references without losing relative URL roots", () => {
    const base = "https://git.example.com/gitlab";
    expect(
      normalizeGitLabUploadUrl(base, "g/p", { full_path: "/-/project/9/uploads/s/a.png" }),
    ).toBe("https://git.example.com/gitlab/-/project/9/uploads/s/a.png");
    expect(
      normalizeGitLabUploadUrl(base, "g/p", { full_path: "/gitlab/-/project/9/uploads/s/a.png" }),
    ).toBe("https://git.example.com/gitlab/-/project/9/uploads/s/a.png");
    expect(normalizeGitLabUploadUrl(base, "g/p", { full_path: "/g/p/uploads/s/a.png" })).toBe(
      "https://git.example.com/gitlab/g/p/uploads/s/a.png",
    );
    expect(normalizeGitLabUploadUrl(base, "g/p", { url: "/uploads/s/a.png" })).toBe(
      "https://git.example.com/gitlab/g/p/uploads/s/a.png",
    );
    expect(
      normalizeGitLabUploadUrl("https://gitlab.com", "g/p", {
        full_path: "/-/project/9/uploads/s/a.png",
      }),
    ).toBe("https://gitlab.com/-/project/9/uploads/s/a.png");
    expect(() =>
      normalizeGitLabUploadUrl(base, "g/p", { full_path: "https://evil.example/x.png" }),
    ).toThrow("different host");
  });

  test("posts multipart uploads to the project and keeps the upload ID", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/projects/g%2Fp"))
        return json({
          id: 9,
          path_with_namespace: "g/p",
          visibility: "private",
          enforce_auth_checks_on_uploads: false,
        });
      return json(
        { id: 5, url: "/uploads/s/screen.png", full_path: "/-/project/9/uploads/s/screen.png" },
        201,
      );
    }) as typeof fetch;
    const adapter = createGitLabUploadAdapter({
      token: "glpat",
      instanceUrl: "https://git.example.com/gitlab",
      projectPath: "g/p",
    });
    const result = await adapter.upload(artifact(), png);
    expect(result).toEqual({
      url: "https://git.example.com/gitlab/-/project/9/uploads/s/screen.png",
      remoteId: "gitlab-upload:9:5",
      notice: expect.stringContaining("anyone with the link"),
      linkPublic: true,
    });
    const upload = requests[1]!;
    expect(upload.url).toBe("https://git.example.com/gitlab/api/v4/projects/9/uploads");
    expect(upload.init?.method).toBe("POST");
    const headers = upload.init?.headers as Record<string, string>;
    expect(headers["PRIVATE-TOKEN"]).toBe("glpat");
    expect(headers["Content-Type"]).toBeUndefined();
    const file = (upload.init?.body as FormData).get("file") as File;
    expect(file.name).toBe("screen.png");
    expect(file.size).toBe(png.byteLength);
  });

  test("reports oversized and forbidden uploads", async () => {
    let status = 413;
    globalThis.fetch = (async (url) =>
      String(url).endsWith("/uploads")
        ? json({ message: "nope" }, status)
        : json({ id: 9, path_with_namespace: "g/p" })) as typeof fetch;
    const adapter = createGitLabUploadAdapter({
      token: "t",
      instanceUrl: "https://gitlab.com",
      projectPath: "g/p",
    });
    await expect(adapter.upload(artifact(), png)).rejects.toThrow("maximum attachment size");
    status = 403;
    await expect(adapter.upload(artifact(), png)).rejects.toThrow("cannot upload files");
  });

  test("describes media access without changing settings", () => {
    expect(
      gitLabMediaAccessNotice({ id: 1, path_with_namespace: "g/p", visibility: "public" }),
    ).toContain("publicly");
    expect(
      gitLabMediaAccessNotice({
        id: 1,
        path_with_namespace: "g/p",
        visibility: "internal",
        enforce_auth_checks_on_uploads: true,
      }),
    ).toContain("must be signed in");
    expect(
      gitLabMediaAccessNotice({ id: 1, path_with_namespace: "g/p", visibility: "private" }),
    ).toContain("unless");
  });
});

describe("managed GitLab artifact note", () => {
  const api = () => new GitLabApi({ token: "t", instanceUrl: "https://git.example.com/gitlab" });

  test("updates only its own marked note across pages", async () => {
    let updated: string | undefined;
    globalThis.fetch = (async (url, init) => {
      const address = new URL(String(url));
      if (address.pathname.endsWith("/user")) return json({ id: 7 });
      if (init?.method === "PUT") {
        updated = address.pathname;
        expect(JSON.parse(String(init.body)).body).toContain("new");
        return json({ id: 300, body: "x" });
      }
      expect(init?.method).toBeUndefined();
      if (address.searchParams.get("page") === "1")
        return json([
          ...Array.from({ length: 98 }, (_, i) => ({ id: i, body: "human", author: { id: 1 } })),
          { id: 200, body: `${ARTIFACT_COMMENT_MARKER}\nforeign`, author: { id: 2 } },
          { id: 201, body: `${ARTIFACT_COMMENT_MARKER}\nsystem`, author: { id: 7 }, system: true },
        ]);
      return json([{ id: 300, body: `${ARTIFACT_COMMENT_MARKER}\nold`, author: { id: 7 } }]);
    }) as typeof fetch;
    const result = await upsertArtifactNote({
      api: api(),
      projectId: 9,
      mergeRequestIid: 3,
      webUrl: "https://git.example.com/gitlab/g/p/-/merge_requests/3",
      body: `${ARTIFACT_COMMENT_MARKER}\nnew`,
    });
    expect(updated).toBe("/gitlab/api/v4/projects/9/merge_requests/3/notes/300");
    expect(result).toEqual({
      status: "published",
      commentId: 300,
      commentUrl: "https://git.example.com/gitlab/g/p/-/merge_requests/3#note_300",
    });
  });

  test("creates a note once when none is managed yet", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (url, init) => {
      methods.push(init?.method ?? "GET");
      if (String(url).endsWith("/user")) return json({ id: 7 });
      if (init?.method === "POST") return json({ id: 11, body: "x" }, 201);
      return json([{ id: 1, body: ARTIFACT_COMMENT_MARKER, author: { id: 8 } }]);
    }) as typeof fetch;
    const result = await upsertArtifactNote({
      api: api(),
      projectId: 9,
      mergeRequestIid: 3,
      webUrl: "https://x/mr/3",
      body: ARTIFACT_COMMENT_MARKER,
    });
    expect(result.commentId).toBe(11);
    expect(methods).toEqual(["GET", "GET", "POST"]);
  });

  const mrRoutes = (createStatus: number, noteStatus: number) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace("/api/v4", "");
      if (path === "/projects/g%2Fp" || path === "/projects/g/p")
        return json({ id: 9, path_with_namespace: "g/p", default_branch: "main", web_url: "w" });
      if (path.includes("/repository/branches/")) return json({});
      if (path === "/projects/9/merge_requests" && init?.method === "POST")
        return createStatus === 201
          ? json({ iid: 3, web_url: "https://gitlab.com/g/p/-/merge_requests/3" }, 201)
          : json({ message: "exists" }, createStatus);
      if (path === "/projects/9/merge_requests")
        return json([
          {
            iid: 4,
            web_url: "https://gitlab.com/g/p/-/merge_requests/4",
            source_branch: "feature",
            target_branch: "main",
            source_project_id: 9,
            target_project_id: 9,
          },
        ]);
      if (path === "/user") return noteStatus === 200 ? json({ id: 7 }) : json({}, noteStatus);
      if (path.endsWith("/notes") && init?.method === "POST") return json({ id: 55 }, 201);
      if (path.endsWith("/notes")) return json([]);
      return json({ message: "unexpected" }, 500);
    }) as typeof fetch;
  const prInfo = {
    title: "T",
    body: "MR description",
    sourceBranch: "feature",
    targetBranch: "main",
    repository: "g/p",
    artifactComment: ARTIFACT_COMMENT_MARKER,
  };

  test("publishes on new and existing merge requests", async () => {
    globalThis.fetch = mrRoutes(201, 200);
    const created = await new GitLabMRClient("t").createPullRequest(prInfo);
    expect(created.success).toBe(true);
    expect(created.artifactPublication?.commentUrl).toBe(
      "https://gitlab.com/g/p/-/merge_requests/3#note_55",
    );
    globalThis.fetch = mrRoutes(409, 200);
    const existing = await new GitLabMRClient("t").createPullRequest(prInfo);
    expect(existing.success).toBe(true);
    expect(existing.artifactPublication?.commentUrl).toContain("merge_requests/4#note_55");
  });

  test("note failures stay advisory", async () => {
    globalThis.fetch = mrRoutes(201, 403);
    const result = await new GitLabMRClient("t").createPullRequest(prInfo);
    expect(result.success).toBe(true);
    expect(result.artifactPublication?.status).toBe("failed");
    expect(result.warnings?.some((warning) => warning.includes("artifact note"))).toBe(true);
  });
});

describe("destination-scoped native publication", () => {
  test("reuses URLs per destination and never across projects", async () => {
    await captureScreenshot();
    let uploads = 0;
    const adapter = {
      upload: async () => ({
        url: `https://host/upload-${++uploads}.png`,
        remoteId: `id-${uploads}`,
      }),
    };
    const first = await uploadSelectedArtifacts(registry, embedPolicy, {
      id: "native-gitlab:https://gitlab.com/g/a",
      adapter,
    });
    const retry = await uploadSelectedArtifacts(registry, embedPolicy, {
      id: "native-gitlab:https://gitlab.com/g/a",
      adapter,
    });
    const other = await uploadSelectedArtifacts(registry, embedPolicy, {
      id: "native-gitlab:https://gitlab.com/g/b",
      adapter,
    });
    expect(first.get("screen")).toBe("https://host/upload-1.png");
    expect(retry.get("screen")).toBe("https://host/upload-1.png");
    expect(other.get("screen")).toBe("https://host/upload-2.png");
    expect(registry.list()[0]!.upload).toMatchObject({ status: "uploaded", remoteId: "id-2" });
  });

  test("failed uploads produce a clear status instead of a local path", async () => {
    await captureScreenshot();
    const failures = new Map<string, string>();
    const urls = await uploadSelectedArtifacts(
      registry,
      embedPolicy,
      {
        id: "native-github:https://github.com/o/r",
        adapter: {
          upload: () => Promise.reject(new Error("GitHub App installation tokens *cannot*")),
        },
      },
      failures,
    );
    expect(urls.size).toBe(0);
    const body = buildArtifactComment(registry, embedPolicy, urls, failures)!.body;
    expect(body).toContain("upload failed: GitHub App installation tokens \\*cannot\\*");
    expect(body).not.toContain(dir);
    expect(registry.list()[0]!.upload?.status).toBe("failed");
  });

  test("upload errors are redacted before reaching the comment, console, or store", async () => {
    await captureScreenshot();
    const token = `ghp_${"A".repeat(36)}`;
    const fineGrained = `github_pat_11${"B".repeat(30)}`;
    const gitlab = `glpat-${"C".repeat(20)}`;
    const presigned =
      "https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=60";
    const failures = new Map<string, string>();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await uploadSelectedArtifacts(
        registry,
        embedPolicy,
        {
          id: "custom",
          adapter: {
            upload: () =>
              Promise.reject(
                new Error(
                  `auth failed with token ${token} at ${presigned}; ${fineGrained} ${gitlab} ` +
                    "https://u:p@host/x.png https://bare-token@host/y.png",
                ),
              ),
          },
        },
        failures,
      );
    } finally {
      console.warn = originalWarn;
    }
    const body = buildArtifactComment(registry, embedPolicy, new Map(), failures)!.body;
    for (const text of [body, failures.get("screen")!, warnings.join("\n")]) {
      expect(text).not.toContain("ghp_");
      expect(text).not.toContain("AAAAAAAAAAAAAAAA");
      expect(text).not.toContain("X-Amz-Signature");
      expect(text).not.toContain("deadbeefcafe");
      expect(text).not.toContain("github_pat_");
      expect(text).not.toContain("BBBBBBBBBBBBBBBB");
      expect(text).not.toContain("glpat-");
      expect(text).not.toContain("CCCCCCCCCCCCCCCC");
      expect(text).not.toContain("u:p@");
      expect(text).not.toContain("bare-token");
    }
    expect(body).toContain("upload failed: auth failed with token \\[redacted\\]");
    expect(registry.list()[0]!.upload?.message).not.toContain("ghp_");
  });

  test("link-public uploads warn the operator and note access in the comment", async () => {
    await captureScreenshot();
    const project = { id: 1, path_with_namespace: "g/a", visibility: "private" as const };
    const notice = gitLabMediaAccessNotice(project);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    let urls: Map<string, string>;
    try {
      urls = await uploadSelectedArtifacts(registry, embedPolicy, {
        id: "native-gitlab:https://gitlab.com/g/a",
        adapter: {
          upload: async () => ({
            url: "https://gitlab.com/g/a/uploads/x/s.png",
            notice,
            linkPublic: true,
          }),
        },
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).toContain("viewable by anyone with its link");
    const body = buildArtifactComment(registry, embedPolicy, urls)!.body;
    expect(body).toContain(
      "_Access: Private project: uploads are viewable by anyone with the link",
    );
    expect(isGitLabUploadLinkPublic(project)).toBe(true);
    expect(isGitLabUploadLinkPublic({ ...project, enforce_auth_checks_on_uploads: true })).toBe(
      false,
    );
    expect(isGitLabUploadLinkPublic({ ...project, visibility: "public" })).toBe(false);
  });
});

// Opt-in live check against github.com (creates a real attachment asset):
// DEVINTERN_LIVE_GITHUB_ATTACHMENT_REPO=owner/repo GITHUB_TOKEN=... bun run test native-artifact-uploaders
const liveRepo = process.env.DEVINTERN_LIVE_GITHUB_ATTACHMENT_REPO;
describe.skipIf(!liveRepo || !process.env.GITHUB_TOKEN)("live GitHub attachment upload", () => {
  test("github.com accepts the native attachment request", async () => {
    globalThis.fetch = originalFetch;
    const uploader = createGitHubAttachmentUploader({
      token: process.env.GITHUB_TOKEN!,
      repository: liveRepo!,
    });
    const result = await uploader.upload(artifact({ name: "devintern-live-check.png" }), png);
    expect(result.url).toMatch(/^https:\/\/github\.com\/user-attachments\/assets\//);
  }, 30_000);
});
