import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectManagedGitHubRepo,
  deleteManagedCloneDir,
  isPathInsideRoot,
  isStrictSubpathOf,
  managedCloneDirName,
  setManagedCloneGitExecForTests,
  setManagedProjectsRootForTests,
} from "./managed-clone.ts";
import {
  setGitHubAuthCryptoForTests,
  setGitHubAuthUserDataDirForTests,
  setGitHubToken,
} from "./github-auth.ts";
import { setUserDataDirForTests } from "./settings.ts";
import type { GitExec } from "./git-sync.ts";
import { rememberProjectBinding } from "./project-bindings.ts";

describe("managedCloneDirName", () => {
  test("builds owner-repo-id basename", () => {
    expect(
      managedCloneDirName({ owner: "Acme", repo: "My App", slug: "acme/my-app" }, "abcd1234"),
    ).toBe("Acme-My-App-abcd1234");
  });
});

describe("connectManagedGitHubRepo", () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setManagedProjectsRootForTests(undefined);
    setManagedCloneGitExecForTests(undefined);
    setGitHubAuthUserDataDirForTests(undefined);
    setGitHubAuthCryptoForTests({});
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("clones into projects root and records a managed binding", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const git: GitExec = async (cwd, args) => {
      if (args[0] === "clone" || args.includes("clone")) {
        await mkdir(join(cwd, ".git"), { recursive: true });
        await writeFile(join(cwd, "README.md"), "ok", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    setManagedCloneGitExecForTests(git);

    const binding = await connectManagedGitHubRepo({ repoInput: "acme/web" });
    expect(binding.managed).toBe(true);
    expect(binding.remote).toBe("acme/web");
    expect(binding.localPath.startsWith(projectsRoot)).toBe(true);
    expect(binding.branch).toBe("main");

    // Second connect reuses the same managed clone (no duplicate).
    const again = await connectManagedGitHubRepo({ repoInput: "acme/web" });
    expect(again.id).toBe(binding.id);
    expect(again.localPath).toBe(binding.localPath);
  });

  test("requires auth when probe says auth_required", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    setManagedProjectsRootForTests(join(tempDir, "projects"));
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(connectManagedGitHubRepo({ repoInput: "acme/private" })).rejects.toThrow(
      /token|private|Connect/i,
    );
  });

  test("blocks clone when token lacks access", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    setManagedProjectsRootForTests(join(tempDir, "projects"));
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });
    await setGitHubToken("ghp_bad");

    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(connectManagedGitHubRepo({ repoInput: "acme/secret" })).rejects.toThrow(
      /does not have access|token/i,
    );
  });

  test("reconnect checks out a requested branch that differs from HEAD", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "main",
      managed: true,
    });

    const gitCalls: string[] = [];
    const git: GitExec = async (_cwd, args) => {
      gitCalls.push(args.join(" "));
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref") {
        // No local develop yet → create with -b (not -B).
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "checkout") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    setManagedCloneGitExecForTests(git);

    const binding = await connectManagedGitHubRepo({
      repoInput: "acme/web",
      branch: "develop",
    });
    expect(binding.branch).toBe("develop");
    expect(gitCalls.some((c) => c === "fetch origin -- develop")).toBe(true);
    expect(gitCalls.some((c) => c === "checkout -b develop FETCH_HEAD")).toBe(true);
    expect(gitCalls.some((c) => c.includes("checkout -B"))).toBe(false);
  });

  test("reconnect without a branch keeps an existing non-default checkout", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "develop",
      managed: true,
    });

    const gitCalls: string[] = [];
    const git: GitExec = async (_cwd, args) => {
      gitCalls.push(args.join(" "));
      return { code: 0, stdout: "develop\n", stderr: "" };
    };
    setManagedCloneGitExecForTests(git);

    const binding = await connectManagedGitHubRepo({ repoInput: "acme/web" });
    expect(binding.branch).toBe("develop");
    expect(gitCalls.some((c) => c.includes("checkout"))).toBe(false);
    expect(gitCalls.some((c) => c.includes("fetch"))).toBe(false);
  });

  test("reconnect switches to an existing local branch and fast-forwards to FETCH_HEAD", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "main",
      managed: true,
    });

    const gitCalls: string[] = [];
    const git: GitExec = async (_cwd, args) => {
      gitCalls.push(args.join(" "));
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "checkout") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge" && args.includes("--ff-only")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    setManagedCloneGitExecForTests(git);

    await connectManagedGitHubRepo({ repoInput: "acme/web", branch: "develop" });
    expect(gitCalls.some((c) => c === "checkout -- develop")).toBe(true);
    expect(gitCalls.some((c) => c === "merge --ff-only FETCH_HEAD")).toBe(true);
    expect(gitCalls.some((c) => c.includes("checkout -B"))).toBe(false);
  });

  test("reconnect surfaces a clear error when local branch cannot fast-forward", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "main",
      managed: true,
    });

    const gitCalls: string[] = [];
    const git: GitExec = async (_cwd, args) => {
      gitCalls.push(args.join(" "));
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        // Local tip is not an ancestor of FETCH_HEAD → refuse before checkout.
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "checkout") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    setManagedCloneGitExecForTests(git);

    await expect(
      connectManagedGitHubRepo({ repoInput: "acme/web", branch: "develop" }),
    ).rejects.toThrow(/fast-forward/i);
    expect(gitCalls.some((c) => c.includes("checkout"))).toBe(false);
  });

  test("reconnect rejects flag-like branch names", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "main",
      managed: true,
    });

    let gitCalled = false;
    setManagedCloneGitExecForTests(async () => {
      gitCalled = true;
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(
      connectManagedGitHubRepo({ repoInput: "acme/web", branch: "--force" }),
    ).rejects.toThrow(/Invalid branch name/i);
    expect(gitCalled).toBe(false);
  });

  test("reconnect allows soft-dirty .gitignore when switching branches", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "main",
      managed: true,
    });

    const gitCalls: string[] = [];
    const git: GitExec = async (_cwd, args) => {
      gitCalls.push(args.join(" "));
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: " M .gitignore\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref") {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "checkout") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    setManagedCloneGitExecForTests(git);

    const binding = await connectManagedGitHubRepo({
      repoInput: "acme/web",
      branch: "develop",
    });
    expect(binding.branch).toBe("develop");
    expect(gitCalls.some((c) => c === "checkout -b develop FETCH_HEAD")).toBe(true);
  });

  test("reconnect on the same branch still fetches and fast-forwards", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "develop",
      managed: true,
    });

    const gitCalls: string[] = [];
    const git: GitExec = async (_cwd, args) => {
      gitCalls.push(args.join(" "));
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "develop\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge" && args.includes("--ff-only")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    setManagedCloneGitExecForTests(git);

    const binding = await connectManagedGitHubRepo({
      repoInput: "acme/web",
      branch: "develop",
    });
    expect(binding.branch).toBe("develop");
    expect(gitCalls.some((c) => c === "fetch origin -- develop")).toBe(true);
    expect(gitCalls.some((c) => c === "merge --ff-only FETCH_HEAD")).toBe(true);
    expect(gitCalls.some((c) => c.includes("checkout"))).toBe(false);
  });

  test("reconnect refuses a branch switch when the tree is hard-dirty", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "main",
      managed: true,
    });

    const git: GitExec = async (_cwd, args) => {
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: " M README.md\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    setManagedCloneGitExecForTests(git);

    await expect(
      connectManagedGitHubRepo({ repoInput: "acme/web", branch: "develop" }),
    ).rejects.toThrow(/local edits/i);
  });

  test("reconnect re-clone refuses a binding path outside the managed projects root", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-clone-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);
    setGitHubAuthUserDataDirForTests(tempDir);
    setGitHubAuthCryptoForTests({ encryptionAvailable: false });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          full_name: "acme/web",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/web.git",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    // Corrupted binding: managed=true but localPath escapes projects root.
    const outside = join(tempDir, "escaped-checkout");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "KEEP.txt"), "do-not-delete", "utf8");
    // Missing .git → reconnect attempts cloneInto (rm + clone).
    await rememberProjectBinding({
      id: "evilpath",
      remote: "acme/web",
      localPath: outside,
      branch: "main",
      managed: true,
    });

    let cloneCalled = false;
    setManagedCloneGitExecForTests(async () => {
      cloneCalled = true;
      return { code: 0, stdout: "", stderr: "" };
    });

    await expect(connectManagedGitHubRepo({ repoInput: "acme/web" })).rejects.toThrow(
      /outside the managed projects/i,
    );
    expect(cloneCalled).toBe(false);
    expect(existsSync(join(outside, "KEEP.txt"))).toBe(true);
  });
});

describe("deleteManagedCloneDir", () => {
  let tempDir: string;

  afterEach(async () => {
    setManagedProjectsRootForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("isPathInsideRoot rejects escapes", () => {
    expect(isPathInsideRoot("/data/projects/acme", "/data/projects")).toBe(true);
    expect(isPathInsideRoot("/data/projects", "/data/projects")).toBe(true);
    expect(isPathInsideRoot("/data/other", "/data/projects")).toBe(false);
    expect(isPathInsideRoot("/data/projects-evil", "/data/projects")).toBe(false);
  });

  test("isStrictSubpathOf rejects the root itself", () => {
    expect(isStrictSubpathOf("/data/projects/acme", "/data/projects")).toBe(true);
    expect(isStrictSubpathOf("/data/projects", "/data/projects")).toBe(false);
    expect(isStrictSubpathOf("/data/projects-evil", "/data/projects")).toBe(false);
  });

  test("deletes under projects root and refuses paths outside", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-del-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    const inside = join(projectsRoot, "acme-web-abcd");
    await mkdir(inside, { recursive: true });
    await writeFile(join(inside, "keep"), "x", "utf8");

    await deleteManagedCloneDir(inside);
    expect(existsSync(inside)).toBe(false);

    const outside = join(tempDir, "not-managed");
    await mkdir(outside, { recursive: true });
    await expect(deleteManagedCloneDir(outside)).rejects.toThrow(/outside the managed projects/i);
    expect(existsSync(outside)).toBe(true);
  });

  test("refuses deleting the managed projects root itself", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-del-root-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    await mkdir(projectsRoot, { recursive: true });
    const sibling = join(projectsRoot, "keep-me");
    await mkdir(sibling, { recursive: true });

    await expect(deleteManagedCloneDir(projectsRoot)).rejects.toThrow(
      /outside the managed projects/i,
    );
    expect(existsSync(projectsRoot)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  });
});
