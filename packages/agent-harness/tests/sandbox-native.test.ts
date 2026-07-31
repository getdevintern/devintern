import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { NativeSandboxProvider } from "../src/sandbox/providers/native.js";
import { applyNestingGuard } from "../src/spawn-agent.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    writablePaths: ["/work/repo", "/tmp/devintern-tasks"],
    network: "open",
    workingDir: "/work/repo",
    harnessName: "claude-code",
    ...overrides,
  };
}

describe("NativeSandboxProvider", () => {
  test("supportsHarness covers only harnesses with a built-in sandbox", () => {
    const provider = new NativeSandboxProvider();
    expect(provider.supportsHarness("claude-code")).toBe(true);
    expect(provider.supportsHarness("codex")).toBe(true);
    // Antigravity's --sandbox is shell-only and auto-bypassed under
    // skip-permissions (antigravity-cli#36); "gemini" is a retired alias
    // that resolves to antigravity before any provider sees it.
    expect(provider.supportsHarness("antigravity")).toBe(false);
    expect(provider.supportsHarness("gemini")).toBe(false);
    expect(provider.supportsHarness("opencode")).toBe(false);
    expect(provider.supportsHarness("goose")).toBe(false);
  });

  test("has the highest auto priority (preferred over external wrappers)", () => {
    expect(new NativeSandboxProvider().priority).toBeGreaterThan(30); // nono is 30
  });

  test("claude-code: appends --settings with a generated sandbox config", () => {
    const wrapped = new NativeSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      ["--dangerously-skip-permissions", "-p", "task"],
      policy(),
    );
    // Executable unchanged: native mode configures, it does not wrap.
    expect(wrapped.path).toBe("/usr/bin/claude");
    expect(wrapped.args.slice(0, 3)).toEqual(["--dangerously-skip-permissions", "-p", "task"]);
    expect(wrapped.args[3]).toBe("--settings");

    const settingsFile = wrapped.args[4] as string;
    expect(settingsFile.startsWith(tmpdir())).toBe(true);
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.excludedCommands).toEqual(["docker *", "gh *"]);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([
      "/work/repo",
      "/tmp/devintern-tasks",
    ]);
    // "open" must be explicit: the sandbox default is deny-with-prompt, which
    // hard-fails in -p print mode with the escape hatch closed.
    expect(settings.sandbox.network.allowedDomains).toEqual(["*"]);
    expect(settings.sandbox.network.allowLocalBinding).toBe(true);
  });

  test("claude-code: ssh-agent socket is allowed through when present", () => {
    const original = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    try {
      const wrapped = new NativeSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
      const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
      expect(settings.sandbox.network.allowUnixSockets).toEqual(["/tmp/ssh-agent.sock"]);
    } finally {
      if (original === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = original;
    }
  });

  test("claude-code: domain allowlist maps to sandbox.network.allowedDomains", () => {
    const wrapped = new NativeSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      [],
      policy({ network: { allowedDomains: ["api.anthropic.com", "github.com"] } }),
    );
    const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
    expect(settings.sandbox.network.allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
  });

  test("codex: keeps --sandbox workspace-write and widens writable roots", () => {
    const wrapped = new NativeSandboxProvider().wrapCommand(
      "/usr/bin/codex",
      ["exec", "--sandbox", "workspace-write", "--ask-for-approval", "never"],
      policy({ harnessName: "codex" }),
    );
    expect(wrapped.path).toBe("/usr/bin/codex");
    expect(wrapped.args.slice(0, 5)).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
    ]);
    const cIndex = wrapped.args.indexOf("-c");
    expect(cIndex).toBeGreaterThan(-1);
    // Extra roots exclude the working dir (codex already allows the workspace).
    expect(wrapped.args[cIndex + 1]).toBe(
      `sandbox_workspace_write.writable_roots=${JSON.stringify(["/tmp/devintern-tasks"])}`,
    );
  });

  test("codex: adds --sandbox workspace-write when absent", () => {
    const wrapped = new NativeSandboxProvider().wrapCommand(
      "/usr/bin/codex",
      ["exec"],
      policy({ harnessName: "codex", writablePaths: ["/work/repo"] }),
    );
    expect(wrapped.args.slice(0, 2)).toEqual(["--sandbox", "workspace-write"]);
  });

  test("throws for harnesses without a built-in sandbox", () => {
    expect(() =>
      new NativeSandboxProvider().wrapCommand("/usr/bin/goose", [], policy({ harnessName: "goose" })),
    ).toThrow("no built-in sandbox");
    expect(() =>
      new NativeSandboxProvider().wrapCommand("/usr/bin/agy", [], policy({ harnessName: "antigravity" })),
    ).toThrow("no built-in sandbox");
  });
});

describe("applyNestingGuard", () => {
  const codexArgs = ["exec", "--sandbox", "workspace-write", "--ask-for-approval", "never"];

  test("on macOS under nono, codex's own sandbox is switched off", () => {
    const guarded = applyNestingGuard("nono", "codex", codexArgs, "darwin");
    expect(guarded).toEqual(["exec", "--sandbox", "danger-full-access", "--ask-for-approval", "never"]);
    expect(codexArgs[2]).toBe("workspace-write"); // input not mutated
  });

  test("on macOS under srt, same adjustment", () => {
    const guarded = applyNestingGuard("srt", "codex", codexArgs, "darwin");
    expect(guarded[2]).toBe("danger-full-access");
  });

  test("on Linux the layers stack: args unchanged", () => {
    expect(applyNestingGuard("nono", "codex", codexArgs, "linux")).toBe(codexArgs);
  });

  test("microVM providers and native mode are not affected", () => {
    expect(applyNestingGuard("docker", "codex", codexArgs, "darwin")).toBe(codexArgs);
    expect(applyNestingGuard("native", "codex", codexArgs, "darwin")).toBe(codexArgs);
  });

  test("non-codex harnesses pass through", () => {
    const args = ["--dangerously-skip-permissions"];
    expect(applyNestingGuard("nono", "claude-code", args, "darwin")).toBe(args);
  });
});
