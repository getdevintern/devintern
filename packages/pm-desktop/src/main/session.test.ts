import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitExec } from "./git-sync.ts";
import type { ProjectGitSyncStatus } from "../shared/project-git-sync.ts";
import { findBindingByLocalPath, rememberProjectBinding } from "./project-bindings.ts";
import { setUserDataDirForTests } from "./settings.ts";
import {
  beginAgentRequest,
  detectCodeConfig,
  detectGitRepository,
  endAgentRequest,
  getSession,
  loadProject,
  setSessionGitExecForTests,
  switchContext,
  switchHarness,
  switchModel,
  switchProjectKey,
  switchTracker,
  updateProjectFromRemote,
} from "./session.ts";

/** Quiet no-remote sync so suitability tests never hit a real remote. */
function noRemoteGitExec(): GitExec {
  return async (_cwd, args) => {
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: "/fake-repo\n", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--abbrev-ref") && args.includes("HEAD")) {
      return { code: 0, stdout: "main\n", stderr: "" };
    }
    if (args[0] === "status") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("@{u}")) {
      return { code: 128, stdout: "", stderr: "no upstream\n" };
    }
    return { code: 1, stdout: "", stderr: `unexpected: git ${args.join(" ")}` };
  };
}

/** Shared branch reply for sync mocks (`rev-parse --abbrev-ref HEAD`). */
function branchRevParse(
  args: readonly string[],
): { code: number; stdout: string; stderr: string } | null {
  if (args[0] === "rev-parse" && args.includes("--abbrev-ref") && args.includes("HEAD")) {
    return { code: 0, stdout: "main\n", stderr: "" };
  }
  return null;
}

async function createGitDirectory(projectDir: string): Promise<void> {
  await mkdir(join(projectDir, ".git"), { recursive: true });
  await writeFile(join(projectDir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

describe("detectCodeConfig", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns false when .devintern-code is absent", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-code-"));
    expect(await detectCodeConfig(tempDir)).toBe(false);
  });

  test("returns true when .devintern-code exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-code-"));
    await mkdir(join(tempDir, ".devintern-code"));
    expect(await detectCodeConfig(tempDir)).toBe(true);
  });

  test("returns true when .devintern-code is in a parent directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-code-"));
    await mkdir(join(tempDir, ".devintern-code"));
    const nested = join(tempDir, "packages", "app");
    await mkdir(nested, { recursive: true });
    expect(await detectCodeConfig(nested)).toBe(true);
  });

  test("returns false when .devintern-code is a regular file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-code-"));
    await writeFile(join(tempDir, ".devintern-code"), "not a directory");
    expect(await detectCodeConfig(tempDir)).toBe(false);
  });
});

describe("detectGitRepository", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns false when no .git exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-git-"));
    expect(detectGitRepository(tempDir)).toBe(false);
  });

  test("ignores an empty ancestor .git directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-git-"));
    await mkdir(join(tempDir, ".git"));
    const nested = join(tempDir, "project");
    await mkdir(nested);
    expect(detectGitRepository(nested)).toBe(false);
  });

  test("returns true when .git is a directory at the project root", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-git-"));
    await createGitDirectory(tempDir);
    expect(detectGitRepository(tempDir)).toBe(true);
  });

  test("returns true for a nested package under a monorepo git root", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-git-"));
    await createGitDirectory(tempDir);
    const nested = join(tempDir, "packages", "app");
    await mkdir(nested, { recursive: true });
    expect(detectGitRepository(nested)).toBe(true);
  });

  test("returns true when .git is a worktree gitfile", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-git-"));
    await writeFile(join(tempDir, ".git"), "gitdir: /tmp/some-git-dir");
    expect(detectGitRepository(tempDir)).toBe(true);
  });
});

describe("loadProject suitability", () => {
  let tempDir: string;

  afterEach(async () => {
    setSessionGitExecForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("marks a non-git folder as unsuitable and unconfigured", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-load-"));
    const status = await loadProject(tempDir);
    expect(status.projectDir).toBe(tempDir);
    expect(status.isGitRepository).toBe(false);
    expect(status.configured).toBe(false);
  });

  test("marks a git folder without PM config as suitable but unconfigured", async () => {
    setSessionGitExecForTests(noRemoteGitExec());
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-load-"));
    await createGitDirectory(tempDir);
    const status = await loadProject(tempDir);
    expect(status.isGitRepository).toBe(true);
    expect(status.configured).toBe(false);
    // No `.devintern-pm` → early return before loadConfig; no configError from missing Jira vars.
    expect(status.configError).toBeUndefined();
    expect(status.activeTrackerId).toBeUndefined();
    expect(status.configuredTrackers).toEqual([]);
    // Bare unconfigured checkout still runs sync (no network via injected exec).
    expect(status.gitSync?.kind).toBe("no_remote");
  });

  test("marks a git folder with incomplete .devintern-pm as unconfigured with configError", async () => {
    setSessionGitExecForTests(noRemoteGitExec());
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-load-"));
    await createGitDirectory(tempDir);
    await mkdir(join(tempDir, ".devintern-pm"));
    await writeFile(join(tempDir, ".devintern-pm", ".env"), "TASK_TRACKER=jira\n");
    const status = await loadProject(tempDir);
    expect(status.isGitRepository).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.configError).toBeDefined();
  });

  test("treats a plain project .env without .devintern-pm as unconfigured", async () => {
    setSessionGitExecForTests(noRemoteGitExec());
    // Mirrors folders like security-agent: git + root .env, no PM config dir.
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-load-"));
    await createGitDirectory(tempDir);
    await writeFile(join(tempDir, ".env"), "GITHUB_TOKEN=not-pm-config\n");
    const status = await loadProject(tempDir);
    expect(status.isGitRepository).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.activeTrackerId).toBeUndefined();
  });

  test("does not inherit stale process.env when .devintern-pm is missing", async () => {
    setSessionGitExecForTests(noRemoteGitExec());
    // After opening a configured project, Electron main keeps Jira vars in process.env.
    // A later folder with only a plain .env must not look configured.
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-load-"));
    await createGitDirectory(tempDir);
    await writeFile(join(tempDir, ".env"), "GITHUB_TOKEN=not-pm-config\n");
    process.env.TASK_TRACKER = "jira";
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.JIRA_EMAIL = "user@example.com";
    process.env.JIRA_API_TOKEN = "fake-token";
    process.env.JIRA_DEFAULT_PROJECT_KEY = "SEC";
    try {
      const status = await loadProject(tempDir);
      expect(status.isGitRepository).toBe(true);
      expect(status.configured).toBe(false);
      expect(status.backendName).toBeUndefined();
    } finally {
      delete process.env.TASK_TRACKER;
      delete process.env.JIRA_BASE_URL;
      delete process.env.JIRA_EMAIL;
      delete process.env.JIRA_API_TOKEN;
      delete process.env.JIRA_DEFAULT_PROJECT_KEY;
    }
  });

  test("refuses configuration when PM config exists outside a git tree", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-load-"));
    await mkdir(join(tempDir, ".devintern-pm"));
    await writeFile(join(tempDir, ".devintern-pm", ".env"), "TASK_TRACKER=markdown\n");
    const status = await loadProject(tempDir);
    expect(status.isGitRepository).toBe(false);
    // loadProject skips engine/config init for non-git folders even when .env is present.
    expect(status.configured).toBe(false);
    expect(status.configuredTrackers).toEqual([]);
    expect(status.activeTrackerId).toBeUndefined();
  });

  test("re-evaluates git status when switching to a different folder", async () => {
    setSessionGitExecForTests(noRemoteGitExec());
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-load-"));
    const gitDir = join(tempDir, "with-git");
    const plainDir = join(tempDir, "no-git");
    await mkdir(gitDir);
    await mkdir(plainDir);
    await createGitDirectory(gitDir);

    const withGit = await loadProject(gitDir);
    expect(withGit.isGitRepository).toBe(true);
    expect(withGit.configured).toBe(false);

    const withoutGit = await loadProject(plainDir);
    expect(withoutGit.isGitRepository).toBe(false);
    expect(withoutGit.projectDir).toBe(plainDir);
  });
});

describe("session git sync integration", () => {
  let tempDir: string;
  let gitCalls: string[];

  afterEach(async () => {
    setSessionGitExecForTests(undefined);
    endAgentRequest("during-update");
    endAgentRequest("during-open");
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  function countingNoRemoteGit(): GitExec {
    gitCalls = [];
    return async (_cwd, args) => {
      gitCalls.push(args.join(" "));
      return noRemoteGitExec()(_cwd, args);
    };
  }

  test("skipGitSync reuses provided snapshot without calling git", async () => {
    setSessionGitExecForTests(countingNoRemoteGit());
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-sync-"));
    await createGitDirectory(tempDir);

    const snapshot: ProjectGitSyncStatus = {
      kind: "ok",
      softDirty: false,
      behind: 0,
      ahead: 0,
      updated: true,
      message: "Updated from remote (1 commit).",
    };
    const status = await loadProject(tempDir, { skipGitSync: true, gitSync: snapshot });
    expect(status.gitSync).toEqual(snapshot);
    expect(gitCalls).toEqual([]);
  });

  test("underContextSwitch reuses lastGitSync without re-fetch", async () => {
    setSessionGitExecForTests(countingNoRemoteGit());
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-sync-"));
    await createGitDirectory(tempDir);

    const first = await loadProject(tempDir);
    expect(first.gitSync?.kind).toBe("no_remote");
    const callsAfterOpen = gitCalls.length;
    expect(callsAfterOpen).toBeGreaterThan(0);

    const second = await loadProject(tempDir, { underContextSwitch: true });
    expect(second.gitSync).toEqual(first.gitSync);
    expect(gitCalls.length).toBe(callsAfterOpen);
  });

  test("updateProjectFromRemote syncs then reloads with skipGitSync", async () => {
    let fetchCount = 0;
    const git: GitExec = async (_cwd, args) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: `${tempDir}\n`, stderr: "" };
      }
      const branch = branchRevParse(args);
      if (branch) return branch;
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("@{u}")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        fetchCount += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { code: 0, stdout: "0\t0\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected: git ${args.join(" ")}` };
    };
    setSessionGitExecForTests(git);

    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-sync-"));
    await createGitDirectory(tempDir);
    await loadProject(tempDir);
    expect(fetchCount).toBe(1);

    const updated = await updateProjectFromRemote();
    expect(updated.gitSync?.kind).toBe("ok");
    expect(updated.gitSync?.updated).toBe(false);
    expect(updated.gitSync?.branch).toBe("main");
    expect(updated.gitSync?.message).toContain("up to date");
    // One fetch on open + one on Update; reload must not fetch again.
    expect(fetchCount).toBe(2);
  });

  test("updateProjectFromRemote holds mutex against agent IPC", async () => {
    let releaseFetch!: () => void;
    const fetchBlocked = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let signalFetchEntered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      signalFetchEntered = resolve;
    });
    const git: GitExec = async (_cwd, args) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: `${tempDir}\n`, stderr: "" };
      }
      const branch = branchRevParse(args);
      if (branch) return branch;
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("@{u}")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        signalFetchEntered();
        await fetchBlocked;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { code: 0, stdout: "0\t0\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected: git ${args.join(" ")}` };
    };
    setSessionGitExecForTests(git);

    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-sync-"));
    await createGitDirectory(tempDir);
    // Seed with a fast no-remote exec so open does not hang on fetchBlocked.
    setSessionGitExecForTests(noRemoteGitExec());
    await loadProject(tempDir);
    setSessionGitExecForTests(git);

    const updating = updateProjectFromRemote();
    await fetchEntered;

    expect(() => beginAgentRequest("during-update")).toThrow(
      /Unavailable while switching project context/,
    );

    releaseFetch!();
    await updating;
    expect(() => beginAgentRequest("during-update")).not.toThrow();
    endAgentRequest("during-update");
  });

  test("Update after open-path skipped_dirty re-fetches once the tree is clean", async () => {
    let hardDirty = true;
    let fetchCount = 0;
    const git: GitExec = async (_cwd, args) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: `${tempDir}\n`, stderr: "" };
      }
      const branch = branchRevParse(args);
      if (branch) return branch;
      if (args[0] === "status") {
        return {
          code: 0,
          stdout: hardDirty ? " M src/app.ts\n" : "",
          stderr: "",
        };
      }
      if (args[0] === "rev-parse" && args.includes("@{u}")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        fetchCount += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { code: 0, stdout: "0\t0\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected: git ${args.join(" ")}` };
    };
    setSessionGitExecForTests(git);

    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-sync-"));
    await createGitDirectory(tempDir);

    const opened = await loadProject(tempDir);
    expect(opened.gitSync?.kind).toBe("skipped_dirty");
    expect(opened.gitSync?.behind).toBeUndefined();
    expect(fetchCount).toBe(0);

    // Still hard-dirty: Update re-classifies with fetch (behind counts).
    const stillDirty = await updateProjectFromRemote();
    expect(stillDirty.gitSync?.kind).toBe("skipped_dirty");
    expect(stillDirty.gitSync?.behind).toBe(0);
    expect(fetchCount).toBe(1);

    // After the user commits/stashes, Update recovers without reopening.
    hardDirty = false;
    const recovered = await updateProjectFromRemote();
    expect(recovered.gitSync?.kind).toBe("ok");
    expect(recovered.gitSync?.updated).toBe(false);
    expect(fetchCount).toBe(2);
  });

  test("pre-fetch hard-dirty skip does not advance lastFetch", async () => {
    const userData = await mkdtemp(join(tmpdir(), "pm-desktop-lastfetch-"));
    setUserDataDirForTests(userData);
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-sync-"));
    await createGitDirectory(tempDir);

    await rememberProjectBinding({
      id: "bind1",
      remote: "acme/web",
      localPath: tempDir,
      managed: true,
      lastFetch: 1000,
    });

    const git: GitExec = async (_cwd, args) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: `${tempDir}\n`, stderr: "" };
      }
      const branch = branchRevParse(args);
      if (branch) return branch;
      if (args[0] === "status") {
        return { code: 0, stdout: " M src/app.ts\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("@{u}")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { code: 0, stdout: "0\t0\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected: git ${args.join(" ")}` };
    };
    setSessionGitExecForTests(git);

    try {
      const opened = await loadProject(tempDir);
      expect(opened.gitSync?.kind).toBe("skipped_dirty");
      expect(opened.gitSync?.fetched).toBeUndefined();
      const binding = await findBindingByLocalPath(tempDir);
      expect(binding?.lastFetch).toBe(1000);
    } finally {
      setUserDataDirForTests(undefined);
      await rm(userData, { recursive: true, force: true });
    }
  });

  test("open-path sync-then-load rebuilds session after fast-forward", async () => {
    // Bare checkout: merge materializes `.devintern-pm` — sync must finish before
    // loadConfig/createEngine so the live session sees the remote tip.
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-open-ff-"));
    await createGitDirectory(tempDir);

    const git: GitExec = async (_cwd, args) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: `${tempDir}\n`, stderr: "" };
      }
      const branch = branchRevParse(args);
      if (branch) return branch;
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("@{u}")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { code: 0, stdout: "0\t1\n", stderr: "" };
      }
      if (args[0] === "merge" && args.includes("--ff-only")) {
        await mkdir(join(tempDir, ".devintern-pm"));
        await writeFile(
          join(tempDir, ".devintern-pm", ".env"),
          "TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=./tasks\n",
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected: git ${args.join(" ")}` };
    };
    setSessionGitExecForTests(git);

    const status = await loadProject(tempDir);
    expect(status.gitSync?.kind).toBe("ok");
    expect(status.gitSync?.updated).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.backendName).toBe("Markdown");
    expect(getSession()?.config.backend.type).toBe("markdown");
  });

  test("open-path sync holds mutex against agent IPC", async () => {
    let releaseFetch!: () => void;
    const fetchBlocked = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let signalFetchEntered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      signalFetchEntered = resolve;
    });
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-open-mutex-"));
    await createGitDirectory(tempDir);

    const git: GitExec = async (_cwd, args) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: `${tempDir}\n`, stderr: "" };
      }
      const branch = branchRevParse(args);
      if (branch) return branch;
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("@{u}")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        signalFetchEntered();
        await fetchBlocked;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list") {
        return { code: 0, stdout: "0\t0\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected: git ${args.join(" ")}` };
    };
    setSessionGitExecForTests(git);

    const opening = loadProject(tempDir);
    await fetchEntered;

    expect(() => beginAgentRequest("during-open")).toThrow(
      /Unavailable while switching project context/,
    );

    releaseFetch!();
    await opening;
    expect(() => beginAgentRequest("during-open")).not.toThrow();
    endAgentRequest("during-open");
  });
});

describe("context switches while an agent is running", () => {
  afterEach(() => {
    // Tests that begin a request must always clear it, even on failure.
    endAgentRequest("test-request");
  });

  test("switchHarness rejects while an agent request is in flight", async () => {
    beginAgentRequest("test-request");
    await expect(switchHarness("opencode")).rejects.toThrow(
      /Unavailable while an agent is running/,
    );
  });

  test("switchTracker rejects while an agent request is in flight", async () => {
    beginAgentRequest("test-request");
    await expect(switchTracker("linear")).rejects.toThrow(/Unavailable while an agent is running/);
  });

  test("switchProjectKey rejects while an agent request is in flight", async () => {
    beginAgentRequest("test-request");
    await expect(switchProjectKey("OTHER")).rejects.toThrow(
      /Unavailable while an agent is running/,
    );
  });

  test("switchModel rejects while an agent request is in flight", async () => {
    beginAgentRequest("test-request");
    await expect(switchModel("sonnet")).rejects.toThrow(/Unavailable while an agent is running/);
  });

  test("loadProject rejects while an agent request is in flight", async () => {
    beginAgentRequest("test-request");
    await expect(loadProject("/tmp/some-project")).rejects.toThrow(
      /Unavailable while an agent is running/,
    );
  });

  test("failed context switch releases the mutex so agents can start again", async () => {
    // May fail for "no project" or leftover lastProjectDir without usable config —
    // either way the mutex must be released so agents can start again.
    await expect(switchHarness("opencode")).rejects.toThrow();
    expect(() => beginAgentRequest("test-request")).not.toThrow();
  });
});

describe("agent requests while a context switch is in flight", () => {
  let tempDir: string;

  afterEach(async () => {
    endAgentRequest("during-switch");
    endAgentRequest("after-switch");
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("beginAgentRequest rejects while switching project context", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-ctx-"));
    // Seed lastProjectDir so switchContext can requireProjectDir.
    await loadProject(tempDir);

    let releasePersist!: () => void;
    const persistBlocked = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    let signalPersistEntered!: () => void;
    const persistEntered = new Promise<void>((resolve) => {
      signalPersistEntered = resolve;
    });

    const switching = switchContext(async () => {
      signalPersistEntered();
      await persistBlocked;
    });

    await persistEntered;

    expect(() => beginAgentRequest("during-switch")).toThrow(
      /Unavailable while switching project context/,
    );

    // External loadProject must also refuse while the switch mutex is held.
    await expect(loadProject(tempDir)).rejects.toThrow(
      /Unavailable while switching project context/,
    );

    releasePersist!();
    await switching;

    expect(() => beginAgentRequest("after-switch")).not.toThrow();
  });
});
