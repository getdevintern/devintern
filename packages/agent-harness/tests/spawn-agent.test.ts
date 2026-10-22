import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { buildDefaultSandboxPolicy, gitAdminPaths, spawnAgent } from "../src/spawn-agent.js";
import type {
  ResolvedSandbox,
  SandboxPolicy,
  SandboxProvider,
  WrappedCommand,
} from "../src/sandbox/types.js";

function fakeSandbox(
  wrap: (path: string, args: readonly string[], policy: SandboxPolicy) => WrappedCommand,
  name = "fake",
  harnessName?: string,
): ResolvedSandbox {
  const provider: SandboxProvider = {
    name,
    displayName: name,
    priority: 1,
    detect: async () => ({ available: true }),
    wrapCommand: wrap,
  };
  return { provider, detection: { available: true }, harnessName };
}

function waitForExit(child: { on: (event: string, cb: (code: number) => void) => unknown }) {
  return new Promise<number>((resolve) => child.on("exit", (code) => resolve(code)));
}

describe("buildDefaultSandboxPolicy", () => {
  test("includes working dir, output dir, tmpdir, and browser caches", () => {
    const policy = buildDefaultSandboxPolicy("/work/repo");
    expect(policy.workingDir).toBe("/work/repo");
    expect(policy.network).toBe("open");
    expect(policy.writablePaths).toContain("/work/repo");
    // darwin grants the parent per-user /var/folders dir (T + C siblings);
    // elsewhere tmpdir() itself.
    const tempScope = process.platform === "darwin" ? dirname(tmpdir()) : tmpdir();
    expect(policy.writablePaths).toContain(tempScope);
    expect(policy.writablePaths.some((p) => p.includes("ms-playwright"))).toBe(true);
    expect(policy.writablePaths.every((p) => p.length > 0)).toBe(true);
    // Browser caches live under the user's home dir
    expect(policy.writablePaths.some((p) => p.startsWith(homedir()))).toBe(true);
  });

  test("applies AGENT_SANDBOX_WRITABLE_PATHS and AGENT_SANDBOX_ALLOWED_DOMAINS", () => {
    const original = { ...process.env };
    process.env.AGENT_SANDBOX_WRITABLE_PATHS = "/data/scratch:/var/cache/app";
    process.env.AGENT_SANDBOX_ALLOWED_DOMAINS = "github.com, api.anthropic.com";
    try {
      const policy = buildDefaultSandboxPolicy("/work");
      expect(policy.writablePaths).toContain("/data/scratch");
      expect(policy.writablePaths).toContain("/var/cache/app");
      expect(policy.network).toEqual({ allowedDomains: ["github.com", "api.anthropic.com"] });
    } finally {
      process.env = { ...original };
    }
  });

  test("grants the source repo's git dir for a linked worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "git-admin-"));
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    const git = (...args: string[]) =>
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    try {
      git("init", "-q", "-b", "main", repo);
      git(
        "-C",
        repo,
        "-c",
        "user.email=a@b",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
      git("-C", repo, "worktree", "add", "-q", worktree, "-b", "feature");

      const commonDir = join(repo, ".git");
      expect(gitAdminPaths(worktree)).toContain(commonDir);

      const policy = buildDefaultSandboxPolicy(worktree);
      expect(policy.writablePaths).toContain(commonDir);
      // The index itself lives inside the common dir, so committing there is writable.
      expect(policy.writablePaths).toContain(join(commonDir, "worktrees", "wt"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("respects DEVINTERN_OUTPUT_DIR", () => {
    const original = process.env.DEVINTERN_OUTPUT_DIR;
    process.env.DEVINTERN_OUTPUT_DIR = "/custom/output";
    try {
      expect(buildDefaultSandboxPolicy("/work").writablePaths).toContain("/custom/output");
    } finally {
      if (original === undefined) delete process.env.DEVINTERN_OUTPUT_DIR;
      else process.env.DEVINTERN_OUTPUT_DIR = original;
    }
  });
});

describe("spawnAgent", () => {
  test("without a sandbox spawns the command directly (today's behavior)", async () => {
    const { child, cleanup } = await spawnAgent({
      resolvedPath: "/bin/echo",
      args: ["direct"],
      spawnOptions: { stdio: ["ignore", "pipe", "ignore"] },
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    const code = await waitForExit(child);
    expect(code).toBe(0);
    expect(out.trim()).toBe("direct");
    await cleanup(); // no-op
  });

  test("with a sandbox spawns the wrapped command and merges env", async () => {
    let seenPolicy: SandboxPolicy | null = null;
    const sandbox = fakeSandbox((path, args, policy) => {
      seenPolicy = policy;
      return {
        path: "/bin/sh",
        args: ["-c", `echo "wrapped:$SANDBOX_MARKER:${path}:${args.join(" ")}"`],
        env: { SANDBOX_MARKER: "on" },
      };
    });

    const { child, cleanup } = await spawnAgent({
      resolvedPath: "/usr/bin/agent",
      args: ["-p", "task"],
      spawnOptions: { stdio: ["ignore", "pipe", "ignore"], cwd: tmpdir() },
      sandbox,
      policy: { writablePaths: ["/extra/path"] },
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    const code = await waitForExit(child);
    expect(code).toBe(0);
    expect(out.trim()).toBe("wrapped:on:/usr/bin/agent:-p task");
    // Default policy merged with the caller's extras
    expect(seenPolicy!.writablePaths).toContain("/extra/path");
    expect(seenPolicy!.writablePaths).toContain(tmpdir());
    expect(seenPolicy!.workingDir).toBe(tmpdir());
    await cleanup();
  });

  test("cleanup hook from the wrapped command is surfaced to the caller", async () => {
    let cleaned = false;
    const sandbox = fakeSandbox(() => ({
      path: "/bin/echo",
      args: ["vm-run"],
      cleanup: async () => {
        cleaned = true;
      },
    }));

    const { child, cleanup } = await spawnAgent({
      resolvedPath: "/usr/bin/agent",
      args: [],
      spawnOptions: { stdio: ["ignore", "ignore", "ignore"] },
      sandbox,
    });
    await waitForExit(child);
    expect(cleaned).toBe(false);
    await cleanup();
    expect(cleaned).toBe(true);
  });
});

describe("spawnAgent Muse credential guard", () => {
  // `--disable-sandbox` is what `applyNestingGuard` adds on macOS under
  // nono/srt. Passing it explicitly keeps this integration check independent of
  // the host platform while still exercising the `spawnAgent` wiring.
  const museArgs = ["exec", "--disable-sandbox"];

  test("threads the denied credential path into the provider policy", async () => {
    let seenPolicy: SandboxPolicy | null = null;
    const sandbox = fakeSandbox(
      (_path, _args, policy) => {
        seenPolicy = policy;
        return { path: "/bin/sh", args: ["-c", "exit 0"] };
      },
      "nono",
      "muse",
    );

    const { child, cleanup } = await spawnAgent({
      resolvedPath: "/usr/bin/muse",
      args: museArgs,
      spawnOptions: {
        stdio: ["ignore", "pipe", "ignore"],
        cwd: tmpdir(),
        env: { HOME: "/home/u", META_API_KEY: "sk-test" },
      },
      sandbox,
    });
    await waitForExit(child);
    await cleanup();

    expect(seenPolicy?.harnessName).toBe("muse");
    expect(seenPolicy?.denyReadPaths).toContain("/home/u/.config/muse/auth.json");
  });

  test("fails actionably before spawning when META_API_KEY is missing", async () => {
    const sandbox = fakeSandbox(
      () => ({ path: "/bin/sh", args: ["-c", "exit 0"] }),
      "nono",
      "muse",
    );

    let caught: unknown;
    try {
      await spawnAgent({
        resolvedPath: "/usr/bin/muse",
        args: museArgs,
        spawnOptions: {
          stdio: ["ignore", "pipe", "ignore"],
          cwd: tmpdir(),
          env: { HOME: "/home/u" },
        },
        sandbox,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("META_API_KEY");
    expect((caught as Error).message).toContain("nono");
  });

  test("leaves non-Muse runs and intact inner sandboxes untouched", async () => {
    let seenPolicy: SandboxPolicy | null = null;
    const sandbox = fakeSandbox(
      (_path, _args, policy) => {
        seenPolicy = policy;
        return { path: "/bin/sh", args: ["-c", "exit 0"] };
      },
      "nono",
      "muse",
    );

    const { child, cleanup } = await spawnAgent({
      resolvedPath: "/usr/bin/muse",
      args: ["exec"],
      spawnOptions: {
        stdio: ["ignore", "pipe", "ignore"],
        cwd: tmpdir(),
        env: { HOME: "/home/u" },
      },
      sandbox,
    });
    await waitForExit(child);
    await cleanup();

    expect(seenPolicy?.denyReadPaths ?? []).toEqual([]);
  });
});
