import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SrtSandboxProvider } from "../src/sandbox/providers/srt.js";
import {
  DSH_HOME_CUSTOM_ROOT_ENV,
  harnessStateAbsolutePaths,
  harnessStatePaths,
  resolveHomeDir,
} from "../src/sandbox/harness-state.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";

const originalDshHome = process.env.DSH_HOME;

afterEach(() => {
  if (originalDshHome === undefined) {
    delete process.env.DSH_HOME;
  } else {
    process.env.DSH_HOME = originalDshHome;
  }
  delete process.env[DSH_HOME_CUSTOM_ROOT_ENV];
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
    expect(harnessStatePaths("deepseek")).toEqual([".dsh"]);
    expect(harnessStateAbsolutePaths("deepseek", "/home/tester")).toEqual(["/home/tester/.dsh"]);
  });

  test("honors a DSH_HOME under $HOME instead of the default ~/.dsh", () => {
    const custom = uniqueHomeChild(".dsh-custom");
    process.env.DSH_HOME = custom;
    expect(harnessStatePaths("deepseek")).toEqual([custom]);
    expect(harnessStateAbsolutePaths("deepseek", "/home/tester")).toEqual([custom]);
  });

  test("expands ~ in DSH_HOME the way dsh does", () => {
    process.env.DSH_HOME = "~/.dsh-custom-tilde";
    expect(harnessStatePaths("deepseek")).toEqual([join(resolveHomeDir(), ".dsh-custom-tilde")]);
  });

  test("resolves relative DSH_HOME against the process cwd like dsh", () => {
    const relative = `.dsh-relative-${process.pid}-${Date.now()}`;
    process.env.DSH_HOME = relative;
    expect(harnessStatePaths("deepseek")).toEqual([resolve(process.cwd(), relative)]);
  });

  test("ignores DSH_HOME=$HOME and other untrusted roots with guidance", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      process.env.DSH_HOME = resolveHomeDir();
      expect(harnessStatePaths("deepseek")).toEqual([".dsh"]);

      process.env.DSH_HOME = "/";
      expect(harnessStatePaths("deepseek")).toEqual([".dsh"]);

      process.env.DSH_HOME = `/tmp/untrusted-dsh-${process.pid}-${Date.now()}`;
      expect(harnessStatePaths("deepseek")).toEqual([".dsh"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnings[0]).toContain("not a trusted sandbox state location");
    expect(warnings[0]).toContain(`${DSH_HOME_CUSTOM_ROOT_ENV}=1`);
  });

  test("an explicit opt-in trusts an otherwise-untrusted DSH_HOME", () => {
    const custom = `/tmp/custom-dsh-${process.pid}-${Date.now()}`;
    process.env.DSH_HOME = custom;
    process.env[DSH_HOME_CUSTOM_ROOT_ENV] = "1";
    expect(harnessStatePaths("deepseek")).toEqual([custom]);
  });

  test("srt grants a custom DSH_HOME", () => {
    const dshHome = mkdtempSync(join(process.cwd(), "dsh-home-"));
    process.env.DSH_HOME = dshHome;
    try {
      mkdirSync(join(dshHome, "profiles"), { recursive: true });
      const wrapped = new SrtSandboxProvider().wrapCommand("/usr/bin/dsh", ["headless"], policy());
      const settings = JSON.parse(readFileSync(wrapped.args[1] as string, "utf8"));
      expect(settings.filesystem.allowWrite).toContain(dshHome);
    } finally {
      rmSync(dshHome, { recursive: true, force: true });
    }
  });
});
