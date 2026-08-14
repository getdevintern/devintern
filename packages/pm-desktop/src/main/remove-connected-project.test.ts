import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitExec } from "./git-sync.ts";
import { setManagedProjectsRootForTests } from "./managed-clone.ts";
import { rememberProjectBinding } from "./project-bindings.ts";
import { removeConnectedProject } from "./remove-connected-project.ts";
import {
  beginAgentRequest,
  clearSession,
  endAgentRequest,
  getSession,
  loadProject,
  requireProjectDir,
  setSessionGitExecForTests,
} from "./session.ts";
import { setUserDataDirForTests } from "./settings.ts";

/** Quiet no-remote sync so open never hits a real remote. */
function noRemoteGitExec(projectDir: string): GitExec {
  return async (_cwd, args) => {
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: `${projectDir}\n`, stderr: "" };
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

describe("removeConnectedProject", () => {
  let tempDir: string;

  afterEach(async () => {
    endAgentRequest("active-during-remove");
    clearSession();
    setSessionGitExecForTests(undefined);
    setManagedProjectsRootForTests(undefined);
    setUserDataDirForTests(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("nulls the live session when deleting the open managed project", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-remove-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);

    const localPath = join(projectsRoot, "acme-web-abcd1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await writeFile(join(localPath, ".git", "HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(localPath, ".devintern-pm"), { recursive: true });
    await writeFile(
      join(localPath, ".devintern-pm", ".env"),
      "TASK_TRACKER=markdown\nMARKDOWN_TASKS_DIR=./tasks\n",
    );
    await rememberProjectBinding({
      id: "abcd1234",
      remote: "acme/web",
      localPath,
      branch: "main",
      managed: true,
    });

    setSessionGitExecForTests(noRemoteGitExec(localPath));
    const status = await loadProject(localPath, { skipGitSync: true });
    expect(status.configured).toBe(true);
    expect(getSession()?.projectDir).toBe(localPath);

    await removeConnectedProject({ localPath, deleteFiles: true });

    expect(getSession()).toBeNull();
    expect(() => requireProjectDir()).toThrow(/No project selected/i);
    expect(existsSync(localPath)).toBe(false);
  });

  test("refuses to remove while an agent request is active", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-remove-busy-"));
    const projectsRoot = join(tempDir, "projects");
    setManagedProjectsRootForTests(projectsRoot);
    setUserDataDirForTests(tempDir);

    const localPath = join(projectsRoot, "acme-web-busy1234");
    await mkdir(join(localPath, ".git"), { recursive: true });
    await writeFile(join(localPath, ".git", "HEAD"), "ref: refs/heads/main\n");
    await rememberProjectBinding({
      id: "busy1234",
      remote: "acme/web",
      localPath,
      branch: "main",
      managed: true,
    });

    beginAgentRequest("active-during-remove");
    await expect(removeConnectedProject({ localPath, deleteFiles: true })).rejects.toThrow(
      /Unavailable while an agent is running/i,
    );
    expect(existsSync(localPath)).toBe(true);
    endAgentRequest("active-during-remove");
  });
});
