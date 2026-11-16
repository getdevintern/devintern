import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeHarness } from "../src/harnesses/opencode.js";
import {
  buildHarnessInvocation,
  parseMajorVersion,
  probeCliVersion,
  probeHarness,
  readCliVersion,
  resetHarnessProbeCache,
} from "../src/probe.js";
import type { AgentHarness } from "../src/types.js";

const tempDirs: string[] = [];

function makeCli(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-probe-"));
  tempDirs.push(dir);
  const cli = join(dir, "opencode");
  writeFileSync(cli, `#!/bin/sh\n${script}\n`, "utf8");
  chmodSync(cli, 0o755);
  return cli;
}

afterEach(() => {
  resetHarnessProbeCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseMajorVersion", () => {
  test("parses common version shapes and surrounding text", () => {
    expect(parseMajorVersion("2.0.23")).toBe(2);
    expect(parseMajorVersion("1.18.29")).toBe(1);
    expect(parseMajorVersion("opencode 3.1")).toBe(3);
    expect(parseMajorVersion("v4.0.0-beta.1")).toBe(4);
  });

  test("returns undefined when no version is present", () => {
    expect(parseMajorVersion("")).toBeUndefined();
    expect(parseMajorVersion("command not found")).toBeUndefined();
  });
});

describe("readCliVersion", () => {
  test("reads the CLI version when the executable exists", () => {
    if (process.platform === "win32") return;
    const cli = makeCli("echo 2.0.23");
    expect(readCliVersion(cli)).toBe("2.0.23");
    expect(new OpencodeHarness().probe(cli)).toEqual({ version: "2.0.23", major: 2 });
  });

  test("returns undefined instead of throwing for a missing executable", () => {
    expect(readCliVersion("/nonexistent/opencode")).toBeUndefined();
    expect(new OpencodeHarness().probe("/nonexistent/opencode")).toEqual({});
  });

  test("returns undefined for a failing probe", () => {
    if (process.platform === "win32") return;
    const cli = makeCli("exit 3");
    expect(readCliVersion(cli)).toBeUndefined();
    expect(probeCliVersion(cli)).toEqual({ failure: "exit 3" });
  });

  test("uses a printed version even when the probe exits non-zero", () => {
    if (process.platform === "win32") return;
    const cli = makeCli(
      'echo "opencode v2.1.2"; echo "PlatformError: EROFS: read-only file system (log 1.2)" >&2; exit 1',
    );
    expect(readCliVersion(cli)).toBe("opencode v2.1.2");
  });

  test("ignores version-like numbers inside error text on a non-zero exit", () => {
    if (process.platform === "win32") return;
    const cli = makeCli('echo "Error at node 20.1.0 loader" >&2; exit 1');
    expect(probeCliVersion(cli)).toEqual({ failure: "exit 1: Error at node 20.1.0 loader" });
  });

  test("passes an explicit env to the --version process", () => {
    if (process.platform === "win32") return;
    const cli = makeCli('echo "probe-env $PROBE_MARKER 9.8.7"');
    expect(readCliVersion(cli, { env: { PATH: process.env.PATH ?? "", PROBE_MARKER: "isolated" } })).toBe(
      "probe-env isolated 9.8.7",
    );
  });
});

describe("OpencodeHarness.probe", () => {
  test("resolves major 2 from a non-zero probe that printed the version", async () => {
    if (process.platform === "win32") return;
    const cli = makeCli('echo "opencode v2.1.2"; echo "EROFS opencode.log" >&2; exit 1');
    expect(await probeHarness(new OpencodeHarness(), cli)).toEqual({
      version: "opencode v2.1.2",
      major: 2,
    });
  });

  test("warns once and returns {} when the version cannot be determined", async () => {
    if (process.platform === "win32") return;
    const cli = makeCli(
      'echo "PlatformError: FileSystem.open (opencode.log)\n  [cause]: Error: EROFS: read-only file system" >&2; exit 1',
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = new OpencodeHarness();
      expect(await probeHarness(harness, cli)).toEqual({});
      expect(await probeHarness(harness, cli)).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("Could not determine opencode version");
      expect(message).toContain(cli);
      expect(message).toContain("exit 1: PlatformError");
      expect(message).toContain("EROFS");
      expect(message).toContain("assuming v1 flags");
    } finally {
      warn.mockRestore();
    }
  });

  test("an explicit env reaches the spawned probe and bypasses the cache", async () => {
    if (process.platform === "win32") return;
    const cli = makeCli('if [ "$PROBE_MARKER" = v2 ]; then echo 2.1.2; else echo 1.18.0; fi');
    const harness = new OpencodeHarness();
    expect((await probeHarness(harness, cli)).major).toBe(1);
    const env = { PATH: process.env.PATH ?? "", PROBE_MARKER: "v2" };
    expect((await probeHarness(harness, cli, { env })).major).toBe(2);
    expect((await probeHarness(harness, cli)).major).toBe(1);
  });
});

describe("probeHarness", () => {
  test("returns an empty probe for harnesses without a probe implementation", async () => {
    const harness = { name: "plain" } as unknown as AgentHarness;
    expect(await probeHarness(harness, "plain")).toEqual({});
  });

  test("caches the probe per harness and executable path", async () => {
    let calls = 0;
    const harness = {
      name: "counted",
      probe: () => {
        calls++;
        return { major: 2 };
      },
    } as unknown as AgentHarness;

    expect(await probeHarness(harness, "/bin/counted")).toEqual({ major: 2 });
    expect(await probeHarness(harness, "/bin/counted")).toEqual({ major: 2 });
    expect(calls).toBe(1);
  });

  test("swallows a probe failure", async () => {
    const harness = {
      name: "broken",
      probe: () => {
        throw new Error("boom");
      },
    } as unknown as AgentHarness;
    expect(await probeHarness(harness, "broken")).toEqual({});
  });
});

describe("buildHarnessInvocation", () => {
  test("forwards the probe env to the harness probe", async () => {
    const seen: unknown[] = [];
    const harness = {
      name: "env-probe",
      buildArgs: () => [],
      probe: (_path: string, options?: { env?: Record<string, string> }) => {
        seen.push(options?.env);
        return {};
      },
    } as unknown as AgentHarness;
    const env = { HOME: "/tmp/isolated" };
    await buildHarnessInvocation(harness, "/bin/x", {}, { env });
    expect(seen).toEqual([env]);
  });

  test("threads the probe into buildArgs and buildEnv", async () => {
    const harness = {
      name: "opencode",
      buildArgs: (_options: unknown, probe?: { major?: number }) =>
        probe?.major && probe.major >= 2 ? ["v2"] : ["v1"],
      buildEnv: (_options: unknown, probe?: { major?: number }) =>
        probe?.major && probe.major >= 2 ? { OPENCODE_LOG_LEVEL: "ERROR" } : undefined,
      probe: () => ({ major: 2 }),
    } as unknown as AgentHarness;

    expect(await buildHarnessInvocation(harness, "/bin/opencode", {})).toEqual({
      args: ["v2"],
      env: { OPENCODE_LOG_LEVEL: "ERROR" },
    });
  });
});
