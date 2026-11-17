import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { MuseHarness } from "../src/harnesses/muse.js";
import { buildPromptArgs, MAX_PROMPT_ARG_BYTES } from "../src/prompt-args.js";
import { resetBunEnvWarning } from "../src/sandbox/bun-env.js";
import { NativeSandboxProvider } from "../src/sandbox/providers/native.js";
import { refineGrantsAgainstDenies } from "../src/sandbox/providers/nono.js";
import { museCredentialPath } from "../src/sandbox/harness-state.js";
import { applyNestingGuard, museCredentialGuard } from "../src/spawn-agent.js";
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
  const originalHome = process.env.HOME;
  let tempHome: string;

  beforeEach(() => {
    // Keep the default Bun cache (~/.cache) writable even when the test
    // process runs inside a sandbox that makes the real home read-only.
    tempHome = mkdtempSync(join(tmpdir(), "native-home-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

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
    // Bun's install root is appended so `bun install` cannot hit a read-only
    // ~/.bun; the policy paths keep their order.
    expect(settings.sandbox.filesystem.allowWrite.slice(0, 2)).toEqual([
      "/work/repo",
      "/tmp/devintern-tasks",
    ]);
    // "open" must be explicit: the sandbox default is deny-with-prompt, which
    // hard-fails in -p print mode with the escape hatch closed.
    expect(settings.sandbox.network.allowedDomains).toEqual(["*"]);
    expect(settings.sandbox.network.allowLocalBinding).toBe(true);
  });

  test("claude-code: gives Bun a writable install root and resolves it on PATH", () => {
    // Auto mode selects native for claude-code, so this provider must apply
    // the same Bun fix as nono instead of leaving BUN_INSTALL at ~/.bun.
    const wrapped = new NativeSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
    const install = wrapped.env?.BUN_INSTALL;
    const temp = wrapped.env?.BUN_TMPDIR;
    expect(typeof install).toBe("string");
    expect(typeof temp).toBe("string");
    expect(install!.startsWith(join(homedir(), ".bun"))).toBe(false);

    const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
    const allowWrite: string[] = settings.sandbox.filesystem.allowWrite;
    expect(allowWrite.some((root) => install === root || install!.startsWith(`${root}/`))).toBe(
      true,
    );

    // `bun install -g` writes launchers to <BUN_INSTALL>/bin, so it must be
    // reachable by name even though the install root is ephemeral — but
    // appended, so it cannot shadow system tools.
    expect(wrapped.env?.PATH?.endsWith(`${delimiter}${join(install!, "bin")}`)).toBe(true);
    expect(wrapped.env?.DEVINTERN_NO_UPDATE).toBe("1");
    expect(wrapped.env?.DEVPM_NO_UPDATE).toBe("1");
  });

  test("claude-code: keeps a configured Bun root the policy grants write access to", () => {
    const root = mkdtempSync(join(tmpdir(), "native-bun-configured-"));
    const install = join(root, "bun");
    const temp = join(root, "bun-tmp");
    try {
      const wrapped = new NativeSandboxProvider().wrapCommand("/usr/bin/claude", [], {
        ...policy({ writablePaths: [root] }),
        env: { BUN_INSTALL: install, BUN_TMPDIR: temp, PATH: process.env.PATH },
      });
      expect(wrapped.env?.BUN_INSTALL).toBeUndefined();
      expect(wrapped.env?.BUN_TMPDIR).toBeUndefined();
      expect(wrapped.env?.PATH).toBeUndefined();
      // The provider must not grant a cache it does not use.
      const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
      expect(settings.sandbox.filesystem.allowWrite).toEqual([root]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude-code: warns once when the Bun cache cannot be created", () => {
    const fakeUid = 999_999_999;
    const realGetuid = process.getuid;
    const home = mkdtempSync(join(tmpdir(), "native-bun-fail-home-"));
    const originalHome = process.env.HOME;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    process.env.HOME = home;
    resetBunEnvWarning();
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    process.getuid = () => fakeUid;
    try {
      new NativeSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
      new NativeSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
    } finally {
      process.getuid = realGetuid;
      process.env.HOME = originalHome;
      console.warn = originalWarn;
      resetBunEnvWarning();
      rmSync(home, { recursive: true, force: true });
    }
    expect(warnings.filter((w) => w.includes("Bun cache unavailable"))).toHaveLength(1);
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
      ["exec", "--sandbox", "workspace-write", "-c", 'approval_policy="never"'],
      policy({ harnessName: "codex" }),
    );
    expect(wrapped.path).toBe("/usr/bin/codex");
    expect(wrapped.args.slice(0, 5)).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
    ]);
    expect(wrapped.args).toContain("sandbox_workspace_write.network_access=true");
    expect(wrapped.args).toContain("features.network_proxy.enabled=true");
    expect(wrapped.args).toContain("features.network_proxy.allow_local_binding=true");
    expect(wrapped.args).toContain('features.network_proxy.domains={ "*" = "allow" }');
    const cIndex = wrapped.args.lastIndexOf("-c");
    expect(cIndex).toBeGreaterThan(-1);
    // Extra roots exclude the working dir (codex already allows the workspace)
    // and include the disposable Bun cache (auto mode picks native for codex).
    const rootsArg = wrapped.args[cIndex + 1] as string;
    expect(rootsArg.startsWith("sandbox_workspace_write.writable_roots=")).toBe(true);
    const roots = JSON.parse(rootsArg.split("=")[1] as string) as string[];
    expect(roots).toContain("/tmp/devintern-tasks");
    expect(roots).not.toContain("/work/repo");
    expect(typeof wrapped.env?.BUN_INSTALL).toBe("string");
    expect(roots.some((root) => (wrapped.env!.BUN_INSTALL as string).startsWith(`${root}/`))).toBe(
      true,
    );
  });

  test("codex: maps a domain allowlist and replaces existing network config", () => {
    const wrapped = new NativeSandboxProvider().wrapCommand(
      "/usr/bin/codex",
      [
        "exec",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-c",
        'features.network_proxy.domains={ "*" = "allow" }',
      ],
      policy({
        harnessName: "codex",
        network: { allowedDomains: ["api.openai.com", "github.com"] },
      }),
    );
    expect(wrapped.args).toContain(
      'features.network_proxy.domains={ "api.openai.com" = "allow", "github.com" = "allow" }',
    );
    expect(wrapped.args).not.toContain('features.network_proxy.domains={ "*" = "allow" }');
    expect(
      wrapped.args.filter((arg) => arg === "sandbox_workspace_write.network_access=true"),
    ).toHaveLength(1);
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
      new NativeSandboxProvider().wrapCommand(
        "/usr/bin/goose",
        [],
        policy({ harnessName: "goose" }),
      ),
    ).toThrow("no built-in sandbox");
    expect(() =>
      new NativeSandboxProvider().wrapCommand(
        "/usr/bin/agy",
        [],
        policy({ harnessName: "antigravity" }),
      ),
    ).toThrow("no built-in sandbox");
  });
});

describe("applyNestingGuard", () => {
  const codexArgs = ["exec", "--sandbox", "workspace-write", "-c", 'approval_policy="never"'];

  test("on macOS under nono, codex's own sandbox is switched off", () => {
    const guarded = applyNestingGuard("nono", "codex", codexArgs, "darwin");
    expect(guarded).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
      "-c",
      'approval_policy="never"',
    ]);
    expect(codexArgs[2]).toBe("workspace-write"); // input not mutated
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

  test("on macOS under nono, Muse's own sandbox is switched off in the option region", () => {
    const museArgs = ["exec", "--disable-request-user-input", "--disable-approval"];
    expect(applyNestingGuard("nono", "muse", museArgs, "darwin")).toEqual([
      "exec",
      "--disable-sandbox",
      "--disable-request-user-input",
      "--disable-approval",
    ]);
    expect(museArgs).not.toContain("--disable-sandbox"); // input not mutated
  });

  test("Muse's guard flag lands before a dash-leading prompt's end-of-options marker", () => {
    const harness = new MuseHarness();
    const prompt = "---\ntype: Task\n---\nImplement";
    const args = [
      ...harness.buildArgs({ skipPermissions: true }),
      ...buildPromptArgs(harness, prompt),
    ];
    const guarded = applyNestingGuard("nono", "muse", args, "darwin");

    const flagIndex = guarded.indexOf("--disable-sandbox");
    const markerIndex = guarded.indexOf("--");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeGreaterThan(-1);
    // Everything after `--` is prompt text for Muse; the flag must not land there.
    expect(flagIndex).toBeLessThan(markerIndex);
    expect(guarded.slice(markerIndex)).toEqual(["--", prompt]);
  });

  test("Muse's guard flag stays in the option region for a --prompt-file run", () => {
    const harness = new MuseHarness();
    const oversized = "x".repeat(MAX_PROMPT_ARG_BYTES + 1);
    const args = [...harness.buildArgs({}), ...buildPromptArgs(harness, oversized)];
    const guarded = applyNestingGuard("nono", "muse", args, "darwin");

    const flagIndex = guarded.indexOf("--disable-sandbox");
    const promptFileIndex = guarded.indexOf("--prompt-file");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(promptFileIndex).toBeGreaterThan(-1);
    expect(flagIndex).toBeLessThan(promptFileIndex);
    expect(guarded.slice(promptFileIndex, promptFileIndex + 2)).toEqual([
      "--prompt-file",
      expect.any(String),
    ]);
  });

  test("Muse keeps its sandbox when explicitly disabled already, on Linux, or in microVMs", () => {
    const yolo = ["exec", "--yolo"];
    expect(applyNestingGuard("nono", "muse", yolo, "darwin")).toBe(yolo);
    const disabled = ["exec", "--disable-sandbox"];
    expect(applyNestingGuard("nono", "muse", disabled, "darwin")).toBe(disabled);
    const args = ["exec", "--disable-approval"];
    expect(applyNestingGuard("nono", "muse", args, "linux")).toBe(args);
    expect(applyNestingGuard("docker", "muse", args, "darwin")).toBe(args);
  });
});

describe("Muse credential guard", () => {
  test("hides the stored auth file from a sandboxed run and requires META_API_KEY", () => {
    const env = { HOME: "/home/u", META_API_KEY: "sk-test" };
    const guarded = museCredentialGuard("nono", "muse", ["exec"], "darwin", env);
    expect(guarded).toEqual({ denyReadPaths: [museCredentialPath(env)] });
    expect(museCredentialPath(env)).toBe("/home/u/.config/muse/auth.json");

    const missingKey = museCredentialGuard("nono", "muse", ["exec"], "darwin", { HOME: "/home/u" });
    expect(missingKey).toBeDefined();
    if (missingKey && "error" in missingKey) {
      expect(missingKey.error).toContain("META_API_KEY");
    } else {
      throw new Error("expected an actionable error when META_API_KEY is unset");
    }
  });

  test("honors XDG_CONFIG_HOME and MUSE_AUTH_PATH", () => {
    expect(museCredentialPath({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg" })).toBe(
      "/cfg/muse/auth.json",
    );
    expect(museCredentialPath({ MUSE_AUTH_PATH: "/tmp/muse-creds.json" })).toBe(
      "/tmp/muse-creds.json",
    );
    // A custom override must not leave the default file readable.
    expect(
      museCredentialGuard("nono", "muse", ["exec"], "darwin", {
        HOME: "/home/u",
        MUSE_AUTH_PATH: "/tmp/muse-creds.json",
        META_API_KEY: "sk-test",
      }),
    ).toEqual({
      denyReadPaths: ["/tmp/muse-creds.json", "/home/u/.config/muse/auth.json"],
    });
  });

  test("nono drops a direct file grant for the denied credential", () => {
    const auth = "/home/u/muse-auth.json";
    expect(refineGrantsAgainstDenies([{ flag: "--read-file", path: auth }], [auth])).toEqual([]);
    expect(
      refineGrantsAgainstDenies(
        [
          { flag: "--read-file", path: auth },
          { flag: "--read", path: "/home/u/.config" },
        ],
        [auth],
      ),
    ).toEqual([{ flag: "--read", path: "/home/u/.config" }]);
  });

  test("does nothing on Linux while Muse's own sandbox is still on, or for other harnesses", () => {
    expect(
      museCredentialGuard("nono", "muse", ["exec"], "linux", { HOME: "/home/u" }),
    ).toBeUndefined();
    expect(
      museCredentialGuard("nono", "claude-code", ["exec"], "darwin", { HOME: "/home/u" }),
    ).toBeUndefined();
    expect(
      museCredentialGuard("docker", "muse", ["exec"], "darwin", { HOME: "/home/u" }),
    ).toBeUndefined();
  });

  test("nono splits a broad state grant instead of granting the auth file", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-cred-"));
    const museDir = join(root, ".config", "muse");
    mkdirSync(museDir, { recursive: true });
    const auth = join(museDir, "auth.json");
    const settings = join(museDir, "settings.json");
    writeFileSync(auth, '{"providers":{"meta":{"access_token":"secret"}}}');
    writeFileSync(settings, '{"schema_version":1}');
    try {
      const grants = refineGrantsAgainstDenies([{ flag: "--allow", path: museDir }], [auth]);
      const paths = grants.map((grant) => grant.path);
      expect(paths).not.toContain(auth);
      expect(paths).toContain(settings);

      // The same deny must survive the broad `$HOME/.config` read grant.
      const broad = refineGrantsAgainstDenies(
        [{ flag: "--read", path: join(root, ".config") }],
        [auth],
      );
      const broadPaths = broad.map((grant) => grant.path);
      expect(broadPaths).not.toContain(auth);
      expect(broadPaths).toContain(settings);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
