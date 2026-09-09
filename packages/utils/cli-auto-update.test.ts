import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectInstallKind,
  fetchLatestVersion,
  installGlobalCliAsync,
  isCliUpdateCheckDue,
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
    let prompts = 0;

    const base = {
      packageName: "@getdevintern/pm",
      binName: "devpm",
      currentVersion: "2.0.0",
      isInteractive: true,
      installKind: "bun-global" as const,
      cachePath,
      checkIntervalMs: 0,
      confirm: async () => {
        prompts++;
        return false;
      },
      fetchFn: async () => new Response(JSON.stringify({ version: "2.1.0" }), { status: 200 }),
      installFn: async () => {
        installed = true;
        return true;
      },
      log: () => {},
      now: () => 5_000,
    };

    expect(await maybeOfferCliUpdate(base)).toBe("skipped");
    expect(await maybeOfferCliUpdate(base)).toBe("skipped");
    expect(prompts).toBe(1);
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

  test("autoInstall installs without a prompt or env opt-in", async () => {
    let installed = false;
    let reexeced = false;
    const logs: string[] = [];

    const result = await maybeOfferCliUpdate({
      packageName: "@getdevintern/code",
      binName: "devintern",
      currentVersion: "1.0.0",
      isInteractive: false,
      autoInstall: true,
      installKind: "bun-global",
      cachePath: join(tempDir(), "cache.json"),
      checkIntervalMs: 0,
      fetchFn: async () => new Response(JSON.stringify({ version: "1.4.0" }), { status: 200 }),
      installFn: async () => {
        installed = true;
        return true;
      },
      reexecFn: () => {
        reexeced = true;
      },
      log: (m) => logs.push(m),
    });

    expect(result).toBe("updated");
    expect(installed).toBe(true);
    expect(reexeced).toBe(true);
    expect(logs.some((line) => line.includes("1.4.0"))).toBe(true);
    expect(logs.some((line) => line.includes("Non-interactive"))).toBe(false);
  });

  test("autoInstall still honors the no-update env opt-out", async () => {
    let installed = false;

    const result = await maybeOfferCliUpdate({
      packageName: "@getdevintern/code",
      binName: "devintern",
      currentVersion: "1.0.0",
      isInteractive: false,
      autoInstall: true,
      installKind: "npm-global",
      noUpdateEnv: "DEVINTERN_NO_UPDATE",
      env: { DEVINTERN_NO_UPDATE: "1" },
      cachePath: join(tempDir(), "cache.json"),
      checkIntervalMs: 0,
      fetchFn: async () => new Response(JSON.stringify({ version: "1.5.0" }), { status: 200 }),
      installFn: async () => {
        installed = true;
        return true;
      },
      log: () => {},
    });

    expect(result).toBe("skipped");
    expect(installed).toBe(false);
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

describe("installGlobalCliAsync", () => {
  type SpawnFn = typeof import("node:child_process").spawn;

  function fakeSpawn(
    outcome: { exitCode?: number | null; error?: Error },
    captured: Array<{ command: string; args: string[] }>,
  ): SpawnFn {
    return ((command: string, args: string[]) => {
      captured.push({ command, args });
      return {
        once: (event: string, handler: (...args: unknown[]) => void) => {
          queueMicrotask(() => {
            if (event === "error" && outcome.error) handler(outcome.error);
            if (event === "exit" && !outcome.error) handler(outcome.exitCode ?? null);
          });
        },
      } as unknown as ChildProcess;
    }) as unknown as SpawnFn;
  }

  test("runs npm install -g and resolves true on exit 0", async () => {
    const captured: Array<{ command: string; args: string[] }> = [];
    const ok = await installGlobalCliAsync({
      packageManager: "npm",
      packageName: "@getdevintern/code",
      version: "1.2.3",
      spawnFn: fakeSpawn({ exitCode: 0 }, captured),
    });
    expect(ok).toBe(true);
    expect(captured).toEqual([
      { command: "npm", args: ["install", "-g", "@getdevintern/code@1.2.3"] },
    ]);
  });

  test("resolves false on a non-zero exit", async () => {
    const captured: Array<{ command: string; args: string[] }> = [];
    const ok = await installGlobalCliAsync({
      packageManager: "bun",
      packageName: "@getdevintern/pm",
      version: "2.0.0",
      spawnFn: fakeSpawn({ exitCode: 1 }, captured),
    });
    expect(ok).toBe(false);
    expect(captured).toEqual([
      { command: "bun", args: ["install", "-g", "@getdevintern/pm@2.0.0"] },
    ]);
  });

  test("resolves false when the package manager cannot be spawned", async () => {
    const ok = await installGlobalCliAsync({
      packageManager: "npm",
      packageName: "@getdevintern/code",
      version: "1.2.3",
      spawnFn: fakeSpawn({ error: new Error("spawn ENOENT") }, []),
    });
    expect(ok).toBe(false);
  });

  test("resolves false when spawn throws synchronously", async () => {
    const ok = await installGlobalCliAsync({
      packageManager: "bun",
      packageName: "@getdevintern/code",
      version: "1.2.3",
      spawnFn: (() => {
        throw new Error("bad arguments");
      }) as unknown as SpawnFn,
    });
    expect(ok).toBe(false);
  });

  test("resolves via 'close' when the child never emits 'exit'", async () => {
    const captured: Array<{ command: string; args: string[] }> = [];
    const ok = await installGlobalCliAsync({
      packageManager: "npm",
      packageName: "@getdevintern/code",
      version: "1.2.3",
      spawnFn: ((command: string, args: string[]) => {
        captured.push({ command, args });
        return {
          once: (event: string, handler: (...args: unknown[]) => void) => {
            if (event === "close") queueMicrotask(() => handler(0));
          },
        } as unknown as ChildProcess;
      }) as unknown as SpawnFn,
    });
    expect(ok).toBe(true);
    expect(captured).toEqual([
      { command: "npm", args: ["install", "-g", "@getdevintern/code@1.2.3"] },
    ]);
  });

  test("kills a hung install and resolves false once the timeout elapses", async () => {
    let killSignal: string | undefined;
    const ok = await installGlobalCliAsync({
      packageManager: "bun",
      packageName: "@getdevintern/code",
      version: "1.2.3",
      timeoutMs: 1,
      spawnFn: ((_command: string, _args: string[]) =>
        ({
          once: () => undefined,
          kill: (signal: string) => {
            killSignal = signal;
          },
        }) as unknown as ChildProcess) as unknown as SpawnFn,
    });
    expect(ok).toBe(false);
    expect(killSignal).toBe("SIGKILL");
  });
});

describe("isCliUpdateCheckDue", () => {
  test("due when the cache file is missing", () => {
    expect(
      isCliUpdateCheckDue({
        packageName: "@getdevintern/code",
        currentVersion: "1.0.0",
        cachePath: join(tempDir(), "absent.json"),
      }),
    ).toBe(true);
  });

  test("not due while the cache is fresh and current", () => {
    const cachePath = join(tempDir(), "cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        "@getdevintern/code": { checkedAt: 1_000, latestVersion: "1.0.0" },
      }),
    );
    expect(
      isCliUpdateCheckDue({
        packageName: "@getdevintern/code",
        currentVersion: "1.0.0",
        cachePath,
        checkIntervalMs: 60_000,
        now: () => 31_000,
      }),
    ).toBe(false);
  });

  test("due once the check interval elapses", () => {
    const cachePath = join(tempDir(), "cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        "@getdevintern/code": { checkedAt: 1_000, latestVersion: "1.0.0" },
      }),
    );
    expect(
      isCliUpdateCheckDue({
        packageName: "@getdevintern/code",
        currentVersion: "1.0.0",
        cachePath,
        checkIntervalMs: 60_000,
        now: () => 61_000,
      }),
    ).toBe(true);
  });

  test("due when the cached latest version is newer (deferred update)", () => {
    const cachePath = join(tempDir(), "cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        "@getdevintern/code": { checkedAt: 1_000, latestVersion: "2.0.0" },
      }),
    );
    expect(
      isCliUpdateCheckDue({
        packageName: "@getdevintern/code",
        currentVersion: "1.0.0",
        cachePath,
        checkIntervalMs: 60_000,
        now: () => 31_000,
      }),
    ).toBe(true);
  });

  test("due when the cache is unreadable", () => {
    const cachePath = join(tempDir(), "cache.json");
    writeFileSync(cachePath, "not json at all");
    expect(
      isCliUpdateCheckDue({
        packageName: "@getdevintern/code",
        currentVersion: "1.0.0",
        cachePath,
      }),
    ).toBe(true);
  });
});
