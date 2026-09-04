import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execSync, spawn as nodeSpawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DockerSandboxProvider } from "../src/sandbox/providers/docker.js";
import { SmolvmSandboxProvider } from "../src/sandbox/providers/smolvm.js";
import { SrtSandboxProvider } from "../src/sandbox/providers/srt.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";

// Bun's mock.module patches the existing module in place, so the namespace
// cannot be used to call through after registration: capture the real
// spawnSync up front and delegate to it from the stub below.
const realSpawnSync = spawnSync;

// The Linux Landlock preflight inside NonoSandboxProvider.wrapCommand shells
// out to `nono run … -- true`; these tests assert argv composition, not the
// host-dependent grant refinement, so stub just that spawn to a fast no-op.
// mock.module is process-global for the whole `bun test` run, so every other
// export — and every non-`nono` spawnSync call — must delegate to the real
// implementation, otherwise the stub leaks into other test files (e.g.
// sandbox-detect.test.ts) and breaks their live-probe assertions.
mock.module("child_process", () => ({
  execSync,
  spawn: nodeSpawn,
  spawnSync: (...callArgs: Parameters<typeof realSpawnSync>) =>
    callArgs[0] === "nono"
      ? { status: 0, stdout: "", stderr: "" }
      : realSpawnSync(...callArgs),
}));

const { NonoSandboxProvider, parseDenyOverlaps, refineGrantsAgainstDenies } =
  await import("../src/sandbox/providers/nono.js");

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    writablePaths: ["/work/repo", "/tmp/devintern-tasks"],
    network: "open",
    workingDir: "/work/repo",
    harnessName: "claude-code",
    ...overrides,
  };
}

describe("NonoSandboxProvider.wrapCommand", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.AGENT_SANDBOX_NONO_PROFILE;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("wraps the agent after -- with policy grants and no profile by default", () => {
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      ["-p", "hi"],
      policy(),
    );
    expect(wrapped.path).toBe("nono");
    expect(wrapped.args[0]).toBe("run");
    // With no env override, macOS uses the harness's nono pack profile when
    // installed (absent otherwise); Linux always passes a generated composite
    // profile file extending linux-host-compat (+ the pack when installed).
    const profileIdx = wrapped.args.indexOf("--profile");
    if (process.platform === "linux") {
      expect(profileIdx).not.toBe(-1);
      const profilePath = wrapped.args[profileIdx + 1] as string;
      expect(profilePath.endsWith("profile.jsonc")).toBe(true);
      const generated = JSON.parse(readFileSync(profilePath, "utf8"));
      expect(generated.extends[0]).toBe("linux-host-compat");
      expect(generated.filesystem.read).toContain("/etc");
    } else if (profileIdx !== -1) {
      expect(wrapped.args[profileIdx + 1]).toBe("claude-code");
    }
    // Agent argv sits verbatim after the -- separator.
    const sep = wrapped.args.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(wrapped.args.slice(sep + 1)).toEqual(["/usr/bin/claude", "-p", "hi"]);
    // Policy writable paths become --allow grants (workingDir may not exist
    // in the test env; the granted set is drawn from the policy).
    const allowIdx = wrapped.args.indexOf("--allow");
    expect(allowIdx === -1 || allowIdx < sep).toBe(true);
    // $HOME read grants never touch nono's protected state root.
    for (let i = 0; i < sep; i++) {
      if (wrapped.args[i] === "--read" || wrapped.args[i] === "--allow") {
        expect(wrapped.args[i + 1]).not.toContain(".local/state/nono");
        expect(wrapped.args[i + 1]).not.toBe(process.env.HOME);
      }
    }
  });

  test("passes AGENT_SANDBOX_NONO_PROFILE as --profile", () => {
    process.env.AGENT_SANDBOX_NONO_PROFILE = "devintern";
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      ["-p", "hi"],
      policy(),
    );
    expect(wrapped.args.slice(0, 3)).toEqual(["run", "--profile", "devintern"]);
    const sep = wrapped.args.indexOf("--");
    expect(wrapped.args.slice(sep + 1)).toEqual(["/usr/bin/claude", "-p", "hi"]);
  });

  test("maps a domain allowlist to repeated --allow-domain flags", () => {
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      [],
      policy({ network: { allowedDomains: ["api.anthropic.com", "github.com"] } }),
    );
    const domains = wrapped.args
      .map((a, i) => (a === "--allow-domain" ? wrapped.args[i + 1] : null))
      .filter(Boolean);
    expect(domains).toEqual(["api.anthropic.com", "github.com"]);
  });

  test("grants cursor-agent write access to ~/.config/cursor", () => {
    const home = process.env.HOME ?? "";
    const cursorConfig = join(home, ".config/cursor");
    if (!existsSync(cursorConfig)) return; // machine-dependent; skip when absent
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/cursor-agent",
      ["-p", "hi"],
      policy({ harnessName: "cursor" }),
    );
    const sep = wrapped.args.indexOf("--");
    const allows: string[] = [];
    for (let i = 0; i < sep; i++) {
      if (wrapped.args[i] === "--allow") allows.push(wrapped.args[i + 1] as string);
    }
    expect(allows).toContain(cursorConfig);
  });

  test("grants /dev/ptmx so lefthook can allocate a PTY", () => {
    if (!existsSync("/dev/ptmx")) return; // absent on some constrained hosts
    const wrapped = new NonoSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
    const sep = wrapped.args.indexOf("--");
    const allowFiles: string[] = [];
    for (let i = 0; i < sep; i++) {
      if (wrapped.args[i] === "--allow-file") allowFiles.push(wrapped.args[i + 1] as string);
    }
    expect(allowFiles).toContain("/dev/ptmx");
  });
});

describe("nono Landlock grant refinement", () => {
  test("parseDenyOverlaps extracts the protected paths from a refusal", () => {
    const stderr = [
      "nono: Sandbox initialization failed: Landlock deny-overlap is not enforceable on Linux.",
      "- deny '/home/u/.config/chromium' overlaps allowed parent '/home/u/.config' (source: user)",
      "- deny '/home/u/.config/bun/bunfig.toml' overlaps allowed parent '/home/u/.config' (source: user)",
      "- ... and 5 more conflict(s)",
    ].join("\n");
    expect(parseDenyOverlaps(stderr)).toEqual([
      "/home/u/.config/chromium",
      "/home/u/.config/bun/bunfig.toml",
    ]);
  });

  test("refineGrantsAgainstDenies expands a conflicting parent into children minus denied subtrees", () => {
    const root = mkdtempSync(join(tmpdir(), "nono-refine-"));
    mkdirSync(join(root, "chromium"));
    mkdirSync(join(root, "git"));
    mkdirSync(join(root, "bun"));
    writeFileSync(join(root, "bun", "bunfig.toml"), "");
    writeFileSync(join(root, "bun", "install.lock"), "");
    writeFileSync(join(root, "starship.toml"), "");

    const refined = refineGrantsAgainstDenies(
      [{ flag: "--read", path: root }],
      [join(root, "chromium"), join(root, "bun", "bunfig.toml")],
    );
    const paths = refined.map((g) => `${g.flag} ${g.path}`).sort();
    expect(paths).toEqual(
      [
        // denied dir skipped; dir containing a denied file expanded one level
        `--read ${join(root, "git")}`,
        `--read-file ${join(root, "bun", "install.lock")}`,
        `--read-file ${join(root, "starship.toml")}`,
      ].sort(),
    );
  });

  test("refineGrantsAgainstDenies leaves unrelated and non-directory grants unchanged", () => {
    const grants = [
      { flag: "--allow", path: "/work/repo" },
      { flag: "--read-file", path: "/home/u/.gitconfig" },
    ] as const;
    expect(refineGrantsAgainstDenies(grants, ["/home/u/.config/chromium"])).toEqual([...grants]);
  });
});

describe("SrtSandboxProvider.wrapCommand", () => {
  test("writes a settings file and passes the agent as argv", () => {
    const wrapped = new SrtSandboxProvider().wrapCommand("/usr/bin/claude", ["-p", "hi"], policy());
    expect(wrapped.path).toBe("srt");
    expect(wrapped.args[0]).toBe("--settings");
    const settingsFile = wrapped.args[1] as string;
    expect(settingsFile.startsWith(tmpdir())).toBe(true);
    expect(wrapped.args.slice(2)).toEqual(["/usr/bin/claude", "-p", "hi"]);

    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    // Policy paths plus (machine-dependent) harness state paths.
    expect(settings.filesystem.allowWrite).toContain("/work/repo");
    expect(settings.filesystem.allowWrite).toContain("/tmp/devintern-tasks");
    // srt's schema requires these fields and rejects "*" in allowedDomains,
    // so the open-network policy maps to the default agent-essentials list.
    expect(settings.filesystem.denyRead).toEqual([]);
    expect(settings.filesystem.denyWrite).toEqual([]);
    expect(settings.network.deniedDomains).toEqual([]);
    expect(settings.network.strictAllowlist).toBe(true);
    expect(settings.network.allowedDomains).not.toContain("*");
    expect(settings.network.allowedDomains).toContain("api.anthropic.com");
    expect(settings.network.allowedDomains).toContain("github.com");
    expect(settings.network.allowedDomains).toContain("registry.npmjs.org");
    expect(settings.network.allowLocalBinding).toBe(true); // dev servers, Playwright CDP
  });

  test("maps a domain allowlist into network.allowedDomains", () => {
    const wrapped = new SrtSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      [],
      policy({ network: { allowedDomains: ["github.com", "*.anthropic.com"] } }),
    );
    const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
    expect(settings.network.allowedDomains).toEqual(["github.com", "*.anthropic.com"]);
  });
});

/** Records create/policy calls instead of spawning a real microVM. */
class StubDockerProvider extends DockerSandboxProvider {
  createCalls: Array<{ sbxAgent: string; sandboxName: string; workingDir: string }> = [];
  policyCalls: Array<{ sandboxName: string; policy: SandboxPolicy }> = [];
  protected override createSandbox(sbxAgent: string, sandboxName: string, workingDir: string) {
    this.createCalls.push({ sbxAgent, sandboxName, workingDir });
  }
  protected override applyNetworkPolicy(sandboxName: string, p: SandboxPolicy) {
    this.policyCalls.push({ sandboxName, policy: p });
  }
}

describe("DockerSandboxProvider.wrapCommand", () => {
  test("creates a named sandbox, applies policy, then execs the agent", () => {
    const provider = new StubDockerProvider();
    const wrapped = provider.wrapCommand(
      "/usr/bin/claude",
      ["--max-turns", "5"],
      policy({ workingDir: "/Users/dev/repo" }),
    );
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]?.sbxAgent).toBe("claude");
    expect(provider.createCalls[0]?.sandboxName).toStartWith("devintern-");
    expect(provider.createCalls[0]?.workingDir).toBe("/Users/dev/repo");
    expect(provider.policyCalls).toHaveLength(1);
    expect(provider.policyCalls[0]?.sandboxName).toBe(provider.createCalls[0]!.sandboxName);

    expect(wrapped.path).toBe("sbx");
    // Exec against the created sandbox; agent argv follows the -- separator.
    expect(wrapped.args).toEqual([
      "exec",
      provider.createCalls[0]!.sandboxName,
      "--",
      "claude",
      "--max-turns",
      "5",
    ]);
    expect(typeof wrapped.cleanup).toBe("function");
  });

  test("rejects unsupported harnesses", () => {
    expect(() =>
      new DockerSandboxProvider().wrapCommand(
        "/usr/bin/goose",
        [],
        policy({ workingDir: "/Users/dev/repo", harnessName: "goose" }),
      ),
    ).toThrow("does not support");
  });

  test("rejects working directories under /tmp (not synced into the VM)", () => {
    expect(() =>
      new DockerSandboxProvider().wrapCommand(
        "/usr/bin/claude",
        [],
        policy({ workingDir: "/tmp/devintern-review-worktree-x" }),
      ),
    ).toThrow("cannot sync");
  });

  test("supportsHarness reflects the allowlist", () => {
    const provider = new DockerSandboxProvider();
    expect(provider.supportsHarness("claude-code")).toBe(true);
    expect(provider.supportsHarness("codex")).toBe(true);
    expect(provider.supportsHarness("goose")).toBe(false);
  });
});

/** Records the boot call instead of spawning a real microVM. */
class StubBootSmolvmProvider extends SmolvmSandboxProvider {
  bootCalls: Array<{ smolvmAgent: string; sandboxName: string; workingDir: string }> = [];
  protected override bootSandbox(smolvmAgent: string, sandboxName: string, workingDir: string) {
    this.bootCalls.push({ smolvmAgent, sandboxName, workingDir });
  }
}

describe("SmolvmSandboxProvider.wrapCommand", () => {
  test("boots a named sandbox, then execs the agent in the working dir", () => {
    const provider = new StubBootSmolvmProvider();
    const wrapped = provider.wrapCommand(
      "/usr/bin/claude",
      ["-p", "hi there"],
      policy({ workingDir: "/Users/dev/repo" }),
    );
    expect(provider.bootCalls).toHaveLength(1);
    expect(provider.bootCalls[0]?.smolvmAgent).toBe("claude");
    expect(provider.bootCalls[0]?.workingDir).toBe("/Users/dev/repo");

    expect(wrapped.path).toBe("smolvm");
    expect(wrapped.args.slice(0, 3)).toEqual([
      "sandbox",
      "exec",
      provider.bootCalls[0]!.sandboxName,
    ]);
    expect(wrapped.args).toContain("--timeout");
    // Agent argv runs via sh -lc from the mounted working dir, shell-quoted.
    const guestCommand = wrapped.args[wrapped.args.length - 1];
    expect(wrapped.args.slice(-3, -1)).toEqual(["sh", "-lc"]);
    expect(guestCommand).toBe(
      'export HOME="$(getent passwd "$(id -u)" | cut -d: -f6)" IS_SANDBOX=1 && ' +
        "cd '/Users/dev/repo' && claude '-p' 'hi there'",
    );
    expect(wrapped.cleanup).toBeInstanceOf(Function);
  });

  test("is excluded from auto selection via priority 0", () => {
    expect(new SmolvmSandboxProvider().priority).toBe(0);
  });

  test("rejects unsupported harnesses", () => {
    expect(() =>
      new SmolvmSandboxProvider().wrapCommand(
        "/usr/bin/goose",
        [],
        policy({ harnessName: "goose" }),
      ),
    ).toThrow("does not support");
  });
});
