import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectInstallKind,
  fetchLatestVersion,
  isNewerVersion,
  maybeOfferCliUpdate,
  parseSemver,
  shouldSkipUpdateCheck,
} from "./src/cli-auto-update.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-auto-update-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseSemver / isNewerVersion", () => {
  test("parses plain and prefixed versions", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("v2.0.0")).toEqual([2, 0, 0]);
    expect(parseSemver("1.2")).toEqual([1, 2, 0]);
    expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseSemver("not-a-version")).toBeNull();
  });

  test("detects newer versions", () => {
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.2", "1.2.3")).toBe(false);
    expect(isNewerVersion("bad", "1.0.0")).toBe(false);
  });
});

describe("shouldSkipUpdateCheck", () => {
  test("skips on help/version/no-update flags", () => {
    expect(shouldSkipUpdateCheck({ argv: ["node", "cli", "--help"], env: {} })).toBe(true);
    expect(shouldSkipUpdateCheck({ argv: ["node", "cli", "--version"], env: {} })).toBe(true);
    expect(shouldSkipUpdateCheck({ argv: ["node", "cli", "--no-update"], env: {} })).toBe(true);
  });

  test("skips on opt-out env vars", () => {
    expect(
      shouldSkipUpdateCheck({
        argv: ["node", "cli"],
        env: { DEVINTERN_NO_UPDATE: "1" },
      }),
    ).toBe(true);
    expect(
      shouldSkipUpdateCheck({
        argv: ["node", "cli"],
        env: { DEVPM_NO_UPDATE: "true" },
        noUpdateEnv: "DEVPM_NO_UPDATE",
      }),
    ).toBe(true);
    expect(shouldSkipUpdateCheck({ argv: ["node", "cli", "PROJ-1"], env: {} })).toBe(false);
  });
});

describe("detectInstallKind", () => {
  test("classifies bun global, npm global, and local paths", () => {
    const home = "/Users/test";
    expect(
      detectInstallKind({
        scriptPath: `${home}/.bun/install/global/node_modules/@getdevintern/code/dist/index.js`,
        packageName: "@getdevintern/code",
        homeDir: home,
      }),
    ).toBe("bun-global");

    expect(
      detectInstallKind({
        scriptPath: "/usr/local/lib/node_modules/@getdevintern/pm/dist/index.js",
        packageName: "@getdevintern/pm",
        homeDir: home,
      }),
    ).toBe("npm-global");

    expect(
      detectInstallKind({
        scriptPath: "/Users/test/Documents/Projects/personal/devintern/packages/code/src/index.ts",
        packageName: "@getdevintern/code",
        homeDir: home,
      }),
    ).toBe("local");

    expect(
      detectInstallKind({
        scriptPath: "/Users/test/my-app/node_modules/@getdevintern/code/dist/index.js",
        packageName: "@getdevintern/code",
        homeDir: home,
      }),
    ).toBe("local");
  });
});

describe("fetchLatestVersion", () => {
  test("returns version from registry JSON", async () => {
    const version = await fetchLatestVersion("@getdevintern/code", {
      fetchFn: async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }),
    });
    expect(version).toBe("9.9.9");
  });

  test("returns null on failure", async () => {
    const version = await fetchLatestVersion("@getdevintern/code", {
      fetchFn: async () => {
        throw new Error("network down");
      },
    });
    expect(version).toBeNull();
  });
});

describe("maybeOfferCliUpdate", () => {
  test("skips local installs without fetching", async () => {
    let fetched = false;
    const result = await maybeOfferCliUpdate({
      packageName: "@getdevintern/code",
      binName: "devintern",
      currentVersion: "1.0.0",
      isInteractive: true,
      installKind: "local",
      fetchFn: async () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      cachePath: join(tempDir(), "cache.json"),
    });
    expect(result).toBe("skipped");
    expect(fetched).toBe(false);
  });

  test("interactive prompt installs and re-execs on yes", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "cache.json");
    let installed: string | null = null;
    let reexeced = false;
    const logs: string[] = [];

    const result = await maybeOfferCliUpdate({
      packageName: "@getdevintern/code",
      binName: "devintern",
      currentVersion: "1.0.0",
      isInteractive: true,
      installKind: "npm-global",
      cachePath,
      checkIntervalMs: 0,
      confirm: async () => true,
      fetchFn: async () => new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 }),
      installFn: async ({ version }) => {
        installed = version;
        return true;
      },
      reexecFn: () => {
        reexeced = true;
      },
      log: (m) => logs.push(m),
      now: () => 1_000_000,
    });

    expect(result).toBe("updated");
    expect(installed).toBe("1.1.0");
    expect(reexeced).toBe(true);
    expect(logs.some((l) => l.includes("1.1.0"))).toBe(true);
    expect(existsSync(cachePath)).toBe(true);
  });

  test("interactive decline records declinedVersion and skips install", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "cache.json");
    let installed = false;

    const result = await maybeOfferCliUpdate({
      packageName: "@getdevintern/pm",
      binName: "devpm",
      currentVersion: "2.0.0",
      isInteractive: true,
      installKind: "bun-global",
      cachePath,
      checkIntervalMs: 0,
      confirm: async () => false,
      fetchFn: async () => new Response(JSON.stringify({ version: "2.1.0" }), { status: 200 }),
      installFn: async () => {
        installed = true;
        return true;
      },
      log: () => {},
    });

    expect(result).toBe("skipped");
    expect(installed).toBe(false);
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cache["@getdevintern/pm"].declinedVersion).toBe("2.1.0");
  });

  test("non-interactive skips install and notifies once", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "cache.json");
    const logs: string[] = [];
    let installCalls = 0;

    const base = {
      packageName: "@getdevintern/code",
      binName: "devintern",
      currentVersion: "1.0.0",
      isInteractive: false,
      installKind: "npm-global" as const,
      cachePath,
      checkIntervalMs: 0,
      fetchFn: async () => new Response(JSON.stringify({ version: "1.2.0" }), { status: 200 }),
      installFn: async () => {
        installCalls++;
        return true;
      },
      log: (m: string) => logs.push(m),
      now: () => 5_000,
    };

    expect(await maybeOfferCliUpdate(base)).toBe("skipped");
    expect(await maybeOfferCliUpdate(base)).toBe("skipped");
    expect(installCalls).toBe(0);
    expect(logs.filter((l) => l.includes("Non-interactive")).length).toBe(1);
  });

  test("non-interactive auto-updates when AUTO_UPDATE env is set", async () => {
    let installed = false;
    let reexeced = false;

    const result = await maybeOfferCliUpdate({
      packageName: "@getdevintern/code",
      binName: "devintern",
      currentVersion: "1.0.0",
      isInteractive: false,
      installKind: "npm-global",
      autoUpdateEnv: "DEVINTERN_AUTO_UPDATE",
      env: { DEVINTERN_AUTO_UPDATE: "1" },
      cachePath: join(tempDir(), "cache.json"),
      checkIntervalMs: 0,
      fetchFn: async () => new Response(JSON.stringify({ version: "1.3.0" }), { status: 200 }),
      installFn: async () => {
        installed = true;
        return true;
      },
      reexecFn: () => {
        reexeced = true;
      },
      log: () => {},
    });

    expect(result).toBe("updated");
    expect(installed).toBe(true);
    expect(reexeced).toBe(true);
  });

  test("respects check interval cache without refetching", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        "@getdevintern/code": {
          checkedAt: 1_000,
          latestVersion: "1.0.0",
        },
      }),
    );

    let fetches = 0;
    const result = await maybeOfferCliUpdate({
      packageName: "@getdevintern/code",
      binName: "devintern",
      currentVersion: "1.0.0",
      isInteractive: true,
      installKind: "npm-global",
      cachePath,
      checkIntervalMs: 60_000,
      now: () => 1_000 + 30_000,
      fetchFn: async () => {
        fetches++;
        return new Response(JSON.stringify({ version: "9.0.0" }), { status: 200 });
      },
      log: () => {},
    });

    expect(result).toBe("skipped");
    expect(fetches).toBe(0);
  });

  test("skips when current version is 0.0.0", async () => {
    const result = await maybeOfferCliUpdate({
      packageName: "@getdevintern/code",
      binName: "devintern",
      currentVersion: "0.0.0",
      isInteractive: true,
      installKind: "npm-global",
      cachePath: join(tempDir(), "cache.json"),
      fetchFn: async () => new Response(JSON.stringify({ version: "9.0.0" }), { status: 200 }),
    });
    expect(result).toBe("skipped");
  });
});
