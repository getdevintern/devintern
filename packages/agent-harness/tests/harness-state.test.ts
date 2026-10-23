import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SrtSandboxProvider } from "../src/sandbox/providers/srt.js";
import {
  DSH_HOME_CUSTOM_ROOT_ENV,
  ensureHarnessStateDir,
  harnessStateAbsolutePaths,
  harnessStatePaths,
  resolveHomeDir,
} from "../src/sandbox/harness-state.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";

const originalDshHome = process.env.DSH_HOME;
const originalHome = process.env.HOME;
const originalCustomStateRoot = process.env[DSH_HOME_CUSTOM_ROOT_ENV];

beforeEach(() => {
  // A developer who exported the opt-in must not silently turn every
  // refusal test into a grant test.
  delete process.env[DSH_HOME_CUSTOM_ROOT_ENV];
});

afterEach(() => {
  if (originalDshHome === undefined) {
    delete process.env.DSH_HOME;
  } else {
    process.env.DSH_HOME = originalDshHome;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalCustomStateRoot === undefined) {
    delete process.env[DSH_HOME_CUSTOM_ROOT_ENV];
  } else {
    process.env[DSH_HOME_CUSTOM_ROOT_ENV] = originalCustomStateRoot;
  }
});

function uniqueHomeChild(name: string): string {
  // Do not create it: a lexical path under $HOME is enough to test resolution.
  return join(resolveHomeDir(), `${name}-${process.pid}-${Date.now()}`);
}

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    writablePaths: ["/work/repo"],
    network: "open",
    workingDir: "/work/repo",
    harnessName: "deepseek",
    ...overrides,
  };
}

describe("harness state paths", () => {
  test("defaults dsh state to ~/.dsh", () => {
    delete process.env.DSH_HOME;
    expect(harnessStatePaths("deepseek", process.env)).toEqual([".dsh"]);
    expect(harnessStateAbsolutePaths("deepseek", "/home/tester", process.env)).toEqual([
      "/home/tester/.dsh",
    ]);
  });

  test("honors a DSH_HOME under $HOME instead of the default ~/.dsh", () => {
    const custom = uniqueHomeChild(".dsh-custom");
    process.env.DSH_HOME = custom;
    expect(harnessStatePaths("deepseek", process.env)).toEqual([custom]);
    expect(harnessStateAbsolutePaths("deepseek", "/home/tester", process.env)).toEqual([custom]);
  });

  test("expands ~ in DSH_HOME the way dsh does", () => {
    process.env.DSH_HOME = "~/.dsh-custom-tilde";
    expect(harnessStatePaths("deepseek", process.env)).toEqual([
      join(resolveHomeDir(), ".dsh-custom-tilde"),
    ]);
  });

  test("resolves relative DSH_HOME against the process cwd like dsh", () => {
    const relative = `.dsh-relative-${process.pid}-${Date.now()}`;
    process.env.DSH_HOME = relative;
    expect(harnessStatePaths("deepseek", process.env)).toEqual([resolve(process.cwd(), relative)]);
  });

  test("ignores DSH_HOME=$HOME and other untrusted roots with guidance", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      process.env.DSH_HOME = resolveHomeDir();
      expect(harnessStatePaths("deepseek", process.env)).toEqual([".dsh"]);

      process.env.DSH_HOME = "/";
      expect(harnessStatePaths("deepseek", process.env)).toEqual([".dsh"]);

      process.env.DSH_HOME = `/tmp/untrusted-dsh-${process.pid}-${Date.now()}`;
      expect(harnessStatePaths("deepseek", process.env)).toEqual([".dsh"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnings[0]).toContain("not a trusted sandbox state location");
    expect(warnings[0]).toContain(`${DSH_HOME_CUSTOM_ROOT_ENV}=1`);
  });

  test("refuses unrelated $HOME subtrees such as ~/.ssh without the opt-in", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      process.env.DSH_HOME = join(resolveHomeDir(), ".ssh");
      expect(harnessStatePaths("deepseek", process.env)).toEqual([".dsh"]);

      // A `.dsh` basename nested under a non-dsh home subtree is still not a
      // dsh-owned state root.
      process.env.DSH_HOME = join(resolveHomeDir(), ".ssh", ".dsh");
      expect(harnessStatePaths("deepseek", process.env)).toEqual([".dsh"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  test("does not treat the filesystem root as the workspace", () => {
    const originalCwd = process.cwd();
    const home = mkdtempSync(join(tmpdir(), "dsh-root-cwd-"));
    process.env.HOME = home;
    process.env.DSH_HOME = join(home, ".ssh");
    try {
      // systemd units without WorkingDirectory (and some cron launchers) run
      // with cwd `/`; every absolute path is then lexically "inside" it.
      process.chdir("/");
      expect(harnessStatePaths("deepseek", process.env)).toEqual([".dsh"]);
      // The untrusted path is not created; the safe default is used instead.
      expect(ensureHarnessStateDir("deepseek", process.env)).toBe(join(home, ".dsh"));
      expect(existsSync(join(home, ".ssh"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("trusts a .dsh directory nested directly under $HOME", () => {
    const custom = join(resolveHomeDir(), ".dsh", `profiles-${process.pid}`);
    process.env.DSH_HOME = custom;
    expect(harnessStatePaths("deepseek", process.env)).toEqual([custom]);
  });

  test("an explicit opt-in trusts an otherwise-untrusted DSH_HOME", () => {
    const custom = `/tmp/custom-dsh-${process.pid}-${Date.now()}`;
    process.env.DSH_HOME = custom;
    process.env[DSH_HOME_CUSTOM_ROOT_ENV] = "1";
    expect(harnessStatePaths("deepseek", process.env)).toEqual([custom]);
  });

  test("srt grants a custom DSH_HOME", () => {
    const dshHome = mkdtempSync(join(process.cwd(), "dsh-home-"));
    process.env.DSH_HOME = dshHome;
    try {
      mkdirSync(join(dshHome, "profiles"), { recursive: true });
      const wrapped = new SrtSandboxProvider(process.env).wrapCommand(
        "/usr/bin/dsh",
        ["headless"],
        policy(),
      );
      const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
      expect(settings.filesystem.allowWrite).toContain(dshHome);
    } finally {
      rmSync(dshHome, { recursive: true, force: true });
    }
  });

  test("srt creates and grants a trusted custom DSH_HOME that does not exist yet", () => {
    const dshHome = join(process.cwd(), `.dsh-fresh-${process.pid}-${Date.now()}`);
    expect(existsSync(dshHome)).toBe(false);
    process.env.DSH_HOME = dshHome;
    try {
      const wrapped = new SrtSandboxProvider(process.env).wrapCommand(
        "/usr/bin/dsh",
        ["headless"],
        policy(),
      );
      const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
      expect(existsSync(dshHome)).toBe(true);
      expect(settings.filesystem.allowWrite).toContain(dshHome);
    } finally {
      rmSync(dshHome, { recursive: true, force: true });
    }
  });

  test("canonicalizes a symlinked $HOME before and after creating DSH_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-symhome-"));
    const realHome = join(root, "real");
    const linkHome = join(root, "link");
    mkdirSync(realHome);
    symlinkSync(realHome, linkHome);
    const canonical = join(realHome, ".dsh-custom");
    process.env.HOME = linkHome;
    process.env.DSH_HOME = "~/.dsh-custom";
    try {
      // The override must be trusted before creation, while it is still a
      // lexical path through the symlinked $HOME.
      expect(harnessStatePaths("deepseek", process.env)).toEqual([canonical]);
      expect(existsSync(canonical)).toBe(false);

      expect(ensureHarnessStateDir("deepseek", process.env)).toBe(canonical);
      expect(existsSync(canonical)).toBe(true);

      // Creating the directory must not flip the trust decision: the next
      // check still yields the same grant instead of falling back to ~/.dsh.
      expect(harnessStatePaths("deepseek", process.env)).toEqual([canonical]);
      expect(harnessStateAbsolutePaths("deepseek", undefined, process.env)).toEqual([canonical]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a DSH_HOME that escapes the workspace through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-symlink-workspace-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(home);
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, "link"));
    const escaped = join(outside, "dsh-state");
    const originalCwd = process.cwd();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    process.env.HOME = home;
    process.env.DSH_HOME = join(workspace, "link", "dsh-state");
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      process.chdir(workspace);
      expect(harnessStatePaths("deepseek", process.env)).toEqual([".dsh"]);
      // The escaped path is never created; the trusted default is used instead.
      expect(ensureHarnessStateDir("deepseek", process.env)).toBe(join(home, ".dsh"));
      expect(existsSync(escaped)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      console.warn = originalWarn;
      rmSync(root, { recursive: true, force: true });
    }
    expect(warnings.some((warning) => warning.includes(escaped))).toBe(true);
  });

  test("creates the default ~/.dsh on a fresh install with no override", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-fresh-home-"));
    process.env.HOME = home;
    delete process.env.DSH_HOME;
    try {
      expect(existsSync(join(home, ".dsh"))).toBe(false);
      expect(ensureHarnessStateDir("deepseek", process.env)).toBe(join(home, ".dsh"));
      expect(existsSync(join(home, ".dsh"))).toBe(true);
      expect(harnessStateAbsolutePaths("deepseek", home, process.env)).toEqual([
        join(home, ".dsh"),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("srt grants the default ~/.dsh on a fresh install", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-fresh-srt-"));
    process.env.HOME = home;
    delete process.env.DSH_HOME;
    try {
      const wrapped = new SrtSandboxProvider(process.env).wrapCommand(
        "/usr/bin/dsh",
        ["headless"],
        policy(),
      );
      const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
      expect(existsSync(join(home, ".dsh"))).toBe(true);
      expect(settings.filesystem.allowWrite).toContain(join(home, ".dsh"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("grants a DSH_HOME merged after module load (repo .env) from a production provider", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-live-env-"));
    const custom = join(home, ".dsh-custom");
    process.env.HOME = home;
    process.env.DSH_HOME = custom;
    try {
      // The registry constructs providers with no snapshot, exactly like the
      // Code/PM hosts. DSH_HOME is merged into process.env after import (the
      // repository .env), and the dsh child inherits that value, so the grant
      // must follow it instead of the startup default ~/.dsh.
      const wrapped = new SrtSandboxProvider().wrapCommand(
        "/usr/bin/dsh",
        ["headless"],
        policy(),
      );
      const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
      expect(settings.filesystem.allowWrite).toContain(custom);
      expect(settings.filesystem.allowWrite).not.toContain(join(home, ".dsh"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("honors a DSH_HOME injected after startup (repo .env merge)", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-startup-dsh-home-"));
    const custom = join(home, ".dsh-custom");
    const modulePath = new URL("../src/sandbox/harness-state.ts", import.meta.url).pathname;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.DSH_HOME;
    delete env[DSH_HOME_CUSTOM_ROOT_ENV];
    const script = [
      `const { harnessStatePaths, ensureHarnessStateDir } = await import(${JSON.stringify(modulePath)});`,
      `process.env.DSH_HOME = ${JSON.stringify(custom)};`,
      `console.log(JSON.stringify([harnessStatePaths("deepseek"), ensureHarnessStateDir("deepseek")]));`,
    ].join("\n");
    try {
      const result = Bun.spawnSync([process.execPath, "-e", script], { env });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(JSON.stringify([[custom], custom]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps the custom-root opt-in startup-gated against a repo .env merge", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-startup-opt-in-"));
    const modulePath = new URL("../src/sandbox/harness-state.ts", import.meta.url).pathname;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.DSH_HOME;
    delete env[DSH_HOME_CUSTOM_ROOT_ENV];
    const script = [
      `const { harnessStatePaths } = await import(${JSON.stringify(modulePath)});`,
      `process.env.DSH_HOME = ${JSON.stringify(join(home, ".ssh"))};`,
      `process.env[${JSON.stringify(DSH_HOME_CUSTOM_ROOT_ENV)}] = "1";`,
      `console.log(JSON.stringify(harnessStatePaths("deepseek")));`,
    ].join("\n");
    try {
      const result = Bun.spawnSync([process.execPath, "-e", script], { env });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(JSON.stringify([".dsh"]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
