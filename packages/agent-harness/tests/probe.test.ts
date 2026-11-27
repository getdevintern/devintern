import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarness } from "../src/harnesses/deepseek.js";
import { OpencodeHarness } from "../src/harnesses/opencode.js";
import { HarnessUnavailableError } from "../src/errors.js";
import {
  buildHarnessInvocation,
  parseMajorVersion,
  parseVersion,
  probeCliVersion,
  probeHarness,
  readCliVersion,
  resetHarnessProbeCache,
} from "../src/probe.js";
import type { AgentHarness } from "../src/types.js";

const tempDirs: string[] = [];

function makeCli(script: string, name = "opencode"): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-probe-"));
  tempDirs.push(dir);
  const cli = join(dir, name);
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
    expect(readCliVersion(cli, {}, "opencode")).toBe("opencode v2.1.2");
  });

  test("keeps stdout and stderr on separate lines on a zero exit", () => {
    if (process.platform === "win32") return;
    const cli = makeCli('echo "1.2.3"; echo "4 plugins loaded" >&2');
    expect(probeCliVersion(cli)).toEqual({ output: "1.2.3\n4 plugins loaded" });
    expect(parseVersion(readCliVersion(cli) ?? "")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("rejects a version prefixed by anything but the program name on a non-zero exit", () => {
    if (process.platform === "win32") return;
    const cli = makeCli('echo "Error 1.2" >&2; exit 1');
    expect(probeCliVersion(cli, {}, "opencode")).toEqual({ failure: "exit 1: Error 1.2" });
    expect(probeCliVersion(cli)).toEqual({ failure: "exit 1: Error 1.2" });
  });

  test("accepts a bare version line on a non-zero exit", () => {
    if (process.platform === "win32") return;
    const cli = makeCli('echo "2.1.2"; echo "boom" >&2; exit 1');
    expect(probeCliVersion(cli, {}, "opencode")).toEqual({ output: "2.1.2" });
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

  test("warns instead of reading a major from error text like `Error 1.2`", async () => {
    if (process.platform === "win32") return;
    const cli = makeCli('echo "Error 1.2" >&2; exit 1');
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await probeHarness(new OpencodeHarness(), cli)).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("exit 1: Error 1.2");
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

  test("deepseek treats unparseable dsh output as no version", () => {
    if (process.platform === "win32") return;
    // Debian/Ubuntu's `dsh` (Dancer's distributed shell) documents no
    // --version; usage text on stdout must not be mistaken for a version.
    const cli = makeCli("echo 'usage: dsh [-options] machine command'", "dsh");
    expect(new DeepSeekHarness().probe(cli)).toEqual({});
  });

  test("deepseek parses the official dsh version", () => {
    if (process.platform === "win32") return;
    const cli = makeCli("echo 'dsh 0.2.1-rc.2'", "dsh");
    expect(new DeepSeekHarness().probe(cli)).toEqual({
      version: "0.2.1-rc.2",
      major: 0,
    });
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

  test("refuses to build a deepseek invocation around the Reasonix binary", async () => {
    const reasonix = makeCli("exit 0", "reasonix");
    const error = await buildHarnessInvocation(new DeepSeekHarness(), reasonix, {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(HarnessUnavailableError);
    expect((error as Error).name).toBe("HarnessUnavailableError");
    expect((error as HarnessUnavailableError).harnessName).toBe("deepseek");
    expect((error as Error).message).toMatch(/AGENT_HARNESS=reasonix/);
  });

  test("builds a deepseek invocation when dsh reports its version", async () => {
    if (process.platform === "win32") return;
    const dsh = makeCli("echo 'dsh 0.2.1-rc.2'", "dsh");
    expect(await buildHarnessInvocation(new DeepSeekHarness(), dsh, {})).toEqual({
      args: ["headless"],
      env: undefined,
    });
  });

  test("refuses a dsh that does not report a DeepSeek Harness version", async () => {
    if (process.platform === "win32") return;
    // Debian/Ubuntu's distributed shell prints usage text instead of a version.
    const dsh = makeCli("echo 'usage: dsh [-options] machine command'", "dsh");
    const error = await buildHarnessInvocation(new DeepSeekHarness(), dsh, {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(HarnessUnavailableError);
    expect((error as HarnessUnavailableError).harnessName).toBe("deepseek");
    expect((error as Error).message).toContain("did not report a DeepSeek Harness version");
    expect((error as Error).message).toContain("DEEPSEEK_CLI_PATH");
  });

  test("refuses a dsh whose --version exits non-zero", async () => {
    if (process.platform === "win32") return;
    const dsh = makeCli("exit 3", "dsh");
    const error = await buildHarnessInvocation(new DeepSeekHarness(), dsh, {}).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(HarnessUnavailableError);
    expect((error as Error).message).toContain("did not report a DeepSeek Harness version");
  });
});
