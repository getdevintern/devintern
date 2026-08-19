import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { Utils } from "../src/lib/utils";

describe("Default branch detection", () => {
  let repoDir: string;
  const remoteDirs: string[] = [];

  function configureOrigin(defaultBranch: string): string {
    execSync(`git branch -M ${defaultBranch}`, { cwd: repoDir });

    const remoteDir = join(
      tmpdir(),
      `default-branch-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    remoteDirs.push(remoteDir);
    mkdirSync(remoteDir, { recursive: true });
    execSync("git init --bare", { cwd: remoteDir });
    execSync(`git symbolic-ref HEAD refs/heads/${defaultBranch}`, { cwd: remoteDir });
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync(`git push -u origin ${defaultBranch}`, { cwd: repoDir });
    return remoteDir;
  }

  beforeEach(() => {
    repoDir = join(
      tmpdir(),
      `default-branch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(repoDir, { recursive: true });

    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    for (const remoteDir of remoteDirs.splice(0)) {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  test("should detect master when main does not exist", async () => {
    execSync("git branch -M master", { cwd: repoDir });

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("master");
    await expect(Utils.resolveDefaultBranch("main", { cwd: repoDir })).resolves.toBe("master");
  });

  test("should detect main when master does not exist", async () => {
    execSync("git branch -M main", { cwd: repoDir });

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("main");
    await expect(Utils.resolveDefaultBranch("master", { cwd: repoDir })).resolves.toBe("main");
  });

  test("uses main immediately when remote metadata identifies main", async () => {
    configureOrigin("main");
    execSync("git checkout -b feature/test", { cwd: repoDir });

    const gitCommands = spyOn(Utils, "executeGitCommand");
    try {
      const branch = await Utils.getMainBranchName({ cwd: repoDir });
      const result = await Utils.pullLatestChanges(branch, { cwd: repoDir });

      expect(branch).toBe("main");
      expect(result.success).toBe(true);
      expect(await Utils.getCurrentBranch(repoDir)).toBe("main");
      expect(gitCommands.mock.calls.map(([args]) => args).flat()).not.toContain("master");
    } finally {
      gitCommands.mockRestore();
    }
  });

  test("does not fetch master when pullLatestChanges is asked for master on a main-only repo", async () => {
    configureOrigin("main");
    execSync("git checkout -b feature/test", { cwd: repoDir });

    const gitCommands = spyOn(Utils, "executeGitCommand");
    try {
      const result = await Utils.pullLatestChanges("master", { cwd: repoDir, verbose: true });

      expect(result.success).toBe(true);
      expect(await Utils.getCurrentBranch(repoDir)).toBe("main");
      const commands = gitCommands.mock.calls.map(([args]) => args.join(" "));
      expect(
        commands.some((command) => command.includes("fetch") && command.includes("master")),
      ).toBe(false);
    } finally {
      gitCommands.mockRestore();
    }
  });

  test("keeps a preferred branch that exists only on the remote", async () => {
    configureOrigin("main");
    execSync("git checkout -b develop", { cwd: repoDir });
    execSync("git push origin develop", { cwd: repoDir });
    execSync("git checkout main", { cwd: repoDir });
    execSync("git branch -D develop", { cwd: repoDir });
    execSync("git update-ref -d refs/remotes/origin/develop", { cwd: repoDir });

    await expect(Utils.resolveDefaultBranch("develop", { cwd: repoDir })).resolves.toBe("develop");
  });

  test("falls back when an explicit preferred branch is missing on the remote", async () => {
    configureOrigin("main");

    await expect(Utils.resolveDefaultBranch("master", { cwd: repoDir })).resolves.toBe("main");
  });

  test("uses master when remote metadata identifies master", async () => {
    configureOrigin("master");

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("master");
  });

  test("supports a custom default branch from remote metadata", async () => {
    configureOrigin("develop");

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("develop");
  });

  test("prefers authoritative remote metadata over a stale cached origin HEAD", async () => {
    const remoteDir = configureOrigin("main");
    execSync("git branch master", { cwd: repoDir });
    execSync("git push origin master", { cwd: repoDir });
    execSync("git remote set-head origin master", { cwd: repoDir });
    execSync("git symbolic-ref HEAD refs/heads/main", { cwd: remoteDir });

    await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("main");
  });

  test("fetches and switches to a newly selected remote default branch", async () => {
    const remoteDir = configureOrigin("master");
    const publisherDir = join(
      tmpdir(),
      `default-branch-publisher-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    remoteDirs.push(publisherDir);
    execSync(`git clone "${remoteDir}" "${publisherDir}"`);
    execSync("git config user.email 'test@test.com'", { cwd: publisherDir });
    execSync("git config user.name 'Test User'", { cwd: publisherDir });
    execSync("git checkout -b main", { cwd: publisherDir });
    writeFileSync(join(publisherDir, "main.txt"), "main branch\n", "utf8");
    execSync("git add main.txt && git commit -m 'Create main' && git push -u origin main", {
      cwd: publisherDir,
    });
    execSync("git symbolic-ref HEAD refs/heads/main", { cwd: remoteDir });

    expect(await Utils.gitRefExists("refs/remotes/origin/main", { cwd: repoDir })).toBe(false);

    const branch = await Utils.getMainBranchName({ cwd: repoDir });
    const result = await Utils.pullLatestChanges(branch, { cwd: repoDir });

    expect(branch).toBe("main");
    expect(result.success).toBe(true);
    expect(await Utils.getCurrentBranch(repoDir)).toBe("main");
    expect(await Utils.gitRefExists("refs/remotes/origin/main", { cwd: repoDir })).toBe(true);
    expect(
      execSync("git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim(),
    ).toBe("origin/main");
  });

  test("uses cached origin HEAD when the bounded noninteractive remote probe fails", async () => {
    configureOrigin("master");
    execSync("git remote set-head origin master", { cwd: repoDir });
    const executeGitCommand = Utils.executeGitCommand;
    const gitCommands = spyOn(Utils, "executeGitCommand").mockImplementation((args, options) => {
      if (args.join(" ") === "ls-remote --symref origin HEAD") {
        expect(options?.timeoutMs).toBe(5000);
        expect(options?.env?.GIT_TERMINAL_PROMPT).toBe("0");
        expect(options?.env?.GCM_INTERACTIVE).toBe("Never");
        expect(options?.env?.GIT_SSH_COMMAND).toBe(
          process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
        );
        return Promise.resolve({ success: false, output: "", error: "authentication failed" });
      }
      return executeGitCommand(args, options);
    });

    try {
      await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("master");
    } finally {
      gitCommands.mockRestore();
    }
  });

  test("uses only local fallbacks when the bounded noninteractive remote probe fails", async () => {
    execSync("git branch -M master", { cwd: repoDir });
    const executeGitCommand = Utils.executeGitCommand;
    const gitCommands = spyOn(Utils, "executeGitCommand").mockImplementation((args, options) => {
      if (args.join(" ") === "ls-remote --symref origin HEAD") {
        expect(options?.timeoutMs).toBe(5000);
        expect(options?.env?.GIT_TERMINAL_PROMPT).toBe("0");
        expect(options?.env?.GCM_INTERACTIVE).toBe("Never");
        expect(options?.env?.GIT_SSH_COMMAND).toBe(
          process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
        );
        return Promise.resolve({ success: false, output: "", error: "authentication failed" });
      }
      return executeGitCommand(args, options);
    });

    try {
      await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("master");
      expect(gitCommands.mock.calls.map(([args]) => args.join(" "))).not.toContain(
        "remote show origin",
      );
    } finally {
      gitCommands.mockRestore();
    }
  });

  test("preserves a custom GIT_SSH_COMMAND for the remote probe", async () => {
    execSync("git branch -M master", { cwd: repoDir });
    const originalSshCommand = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "custom-ssh-wrapper --nonstandard-option";
    const executeGitCommand = Utils.executeGitCommand;
    const gitCommands = spyOn(Utils, "executeGitCommand").mockImplementation((args, options) => {
      if (args.join(" ") === "ls-remote --symref origin HEAD") {
        expect(options?.env?.GIT_SSH_COMMAND).toBe("custom-ssh-wrapper --nonstandard-option");
        return Promise.resolve({ success: false, output: "", error: "unreachable" });
      }
      return executeGitCommand(args, options);
    });

    try {
      await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("master");
    } finally {
      gitCommands.mockRestore();
      if (originalSshCommand === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = originalSshCommand;
      }
    }
  });

  test("preserves core.sshCommand for the remote probe", async () => {
    if (process.platform === "win32") {
      return;
    }

    const remoteDir = configureOrigin("main");
    execSync("git branch master", { cwd: repoDir });
    execSync("git push origin master", { cwd: repoDir });
    execSync("git remote set-head origin master", { cwd: repoDir });
    const sshWrapper = join(repoDir, "ssh-wrapper");
    const wrapperMarker = join(repoDir, "ssh-wrapper-invoked");
    writeFileSync(
      sshWrapper,
      `#!/bin/sh\nprintf invoked > "${wrapperMarker}"\nif [ "$1" = "-G" ]; then\n  exit 0\nfi\nfor argument do\n  command="$argument"\ndone\nexec /bin/sh -c "$command"\n`,
      "utf8",
    );
    chmodSync(sshWrapper, 0o755);
    execSync(`git config core.sshCommand "${sshWrapper}"`, { cwd: repoDir });
    execSync(`git remote set-url origin "ssh://required-wrapper${remoteDir}"`, { cwd: repoDir });

    const originalSshCommand = process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_COMMAND;
    try {
      await expect(Utils.getMainBranchName({ cwd: repoDir })).resolves.toBe("main");
      expect(readFileSync(wrapperMarker, "utf8")).toBe("invoked");
    } finally {
      if (originalSshCommand !== undefined) {
        process.env.GIT_SSH_COMMAND = originalSshCommand;
      }
    }
  });

  test("terminates descendant processes before a timed-out git command resolves", async () => {
    const shimDir = join(
      tmpdir(),
      `default-branch-git-shim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    remoteDirs.push(shimDir);
    mkdirSync(shimDir, { recursive: true });
    const childPidFile = join(shimDir, "child.pid");
    const gitShim = join(shimDir, process.platform === "win32" ? "git.cmd" : "git");
    if (process.platform === "win32") {
      const childScript = join(shimDir, "child.ts");
      writeFileSync(
        childScript,
        "await Bun.write(process.argv[2]!, String(process.pid));\nawait Bun.sleep(30_000);\n",
        "utf8",
      );
      writeFileSync(
        gitShim,
        '@echo off\r\n"%BUN_EXEC_PATH%" "%CHILD_SCRIPT%" "%CHILD_PID_FILE%"\r\n',
        "utf8",
      );
    } else {
      writeFileSync(
        gitShim,
        '#!/bin/sh\nsleep 30 &\nchild_pid=$!\nprintf "%s\\n" "$child_pid" > "$CHILD_PID_FILE"\nwait "$child_pid"\n',
        "utf8",
      );
      chmodSync(gitShim, 0o755);
    }

    const result = await Utils.executeGitCommand(["status"], {
      cwd: repoDir,
      timeoutMs: 250,
      env: {
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
        BUN_EXEC_PATH: process.execPath,
        CHILD_SCRIPT: join(shimDir, "child.ts"),
        CHILD_PID_FILE: childPidFile,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Git command timed out after 250ms");
    const childPid = Number(readFileSync(childPidFile, "utf8").trim());
    let childIsAlive = true;
    for (let attempt = 0; attempt < 50 && childIsAlive; attempt++) {
      try {
        process.kill(childPid, 0);
        await Bun.sleep(20);
      } catch {
        childIsAlive = false;
      }
    }
    expect(childIsAlive).toBe(false);
  });

  test("should fall back to master when pullLatestChanges is asked for main", async () => {
    execSync("git branch -M master", { cwd: repoDir });

    const result = await Utils.pullLatestChanges("main", { cwd: repoDir });

    expect(await Utils.getCurrentBranch(repoDir)).toBe("master");
    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to pull");
  });

  test("remoteBranchExists reports presence of a branch on origin", async () => {
    execSync("git branch -M master", { cwd: repoDir });

    const remoteDir = join(
      tmpdir(),
      `default-branch-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    remoteDirs.push(remoteDir);
    mkdirSync(remoteDir, { recursive: true });
    execSync("git init --bare", { cwd: remoteDir });
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push origin master", { cwd: repoDir });

    await expect(Utils.remoteBranchExists("master", { cwd: repoDir })).resolves.toBe(true);
    await expect(Utils.remoteBranchExists("main", { cwd: repoDir })).resolves.toBe(false);
  });
});
