import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "os";
import { dirname } from "path";
import { buildDefaultSandboxPolicy, spawnAgent } from "../src/spawn-agent.js";
import type {
  ResolvedSandbox,
  SandboxPolicy,
  SandboxProvider,
  WrappedCommand,
} from "../src/sandbox/types.js";

function fakeSandbox(
  wrap: (path: string, args: readonly string[], policy: SandboxPolicy) => WrappedCommand,
): ResolvedSandbox {
  const provider: SandboxProvider = {
    name: "fake",
    displayName: "fake",
    priority: 1,
    detect: async () => ({ available: true }),
    wrapCommand: wrap,
  };
  return { provider, detection: { available: true } };
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
