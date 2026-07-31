import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectSandboxProviders } from "../src/sandbox/detect.js";
import { probeCommand } from "../src/sandbox/probe.js";
import { NonoSandboxProvider } from "../src/sandbox/providers/nono.js";
import { SrtSandboxProvider } from "../src/sandbox/providers/srt.js";

/** Create an isolated bin dir with executable stub scripts. */
function makeBinDir(stubs: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-detect-test-"));
  for (const [name, body] of Object.entries(stubs)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

describe("sandbox detection", () => {
  const originalPath = process.env.PATH;
  let binDir: string | null = null;

  beforeEach(() => {
    binDir = null;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (binDir) rmSync(binDir, { recursive: true, force: true });
  });

  test("provider reports unavailable with an install hint when binary is missing", async () => {
    binDir = makeBinDir({});
    // Keep system dirs so `which` itself still works; nono is not in them.
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
    const detection = await new NonoSandboxProvider().detect();
    expect(detection.available).toBe(false);
    expect(detection.reason).toContain("nono.sh");
  });

  test("provider reports available with version when binary is on PATH", async () => {
    binDir = makeBinDir({ nono: 'echo "nono 1.2.3"' });
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
    const detection = await new NonoSandboxProvider().detect();
    expect(detection.available).toBe(true);
    expect(detection.version).toBe("nono 1.2.3");
  });

  test("srt on Linux requires bubblewrap, socat, and ripgrep", async () => {
    if (process.platform !== "linux") return; // Linux-only dependency check
    binDir = makeBinDir({ srt: 'echo "srt 0.1.0"' });
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
    const detection = await new SrtSandboxProvider().detect();
    // On hosts that already have bwrap/socat/rg installed detection succeeds;
    // otherwise the reason must name the missing dependencies.
    if (!detection.available) {
      expect(detection.reason).toContain("missing");
    }
  });

  test("detectSandboxProviders returns one entry per registered provider and caches", async () => {
    const first = await detectSandboxProviders({ fresh: true });
    const names = first.map((d) => d.provider.name);
    expect(names).toContain("nono");
    expect(names).toContain("srt");
    expect(names).toContain("docker");
    expect(names).toContain("smolvm");

    const second = await detectSandboxProviders();
    expect(second).toBe(first); // cached: same promise result
  });

  test("probeCommand returns null for missing binaries and output for working ones", () => {
    expect(probeCommand("definitely-not-a-real-binary-xyz", ["--version"])).toBeNull();
    expect(probeCommand("echo", ["hello"])).toBe("hello");
  });
});
