import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SrtSandboxProvider } from "../src/sandbox/providers/srt.js";
import { harnessStateAbsolutePaths, harnessStatePaths } from "../src/sandbox/harness-state.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";

const originalDshHome = process.env.DSH_HOME;

afterEach(() => {
  if (originalDshHome === undefined) {
    delete process.env.DSH_HOME;
  } else {
    process.env.DSH_HOME = originalDshHome;
  }
});

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

  test("honors DSH_HOME instead of the default ~/.dsh", () => {
    process.env.DSH_HOME = "/tmp/custom-dsh";
    expect(harnessStatePaths("deepseek")).toEqual(["/tmp/custom-dsh"]);
    expect(harnessStateAbsolutePaths("deepseek", "/home/tester")).toEqual(["/tmp/custom-dsh"]);
  });

  test("srt grants a custom DSH_HOME", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
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
