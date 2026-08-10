/**
 * Shared CLI self-update check for `devintern` and `devpm`.
 *
 * Fetches the latest version from the npm registry, optionally prompts (or
 * auto-installs), and re-execs the process so the user runs the new binary.
 *
 * Policy:
 * - Interactive TTY: offer update (prompt)
 * - Non-interactive (CI, workers, scripts): skip install (safe default);
 *   print a one-line notice at most once per check window
 * - Opt-out: `DEVINTERN_NO_UPDATE=1` / `DEVPM_NO_UPDATE=1`, or `--no-update`
 * - Opt-in auto install when non-interactive: `DEVINTERN_AUTO_UPDATE=1` /
 *   `DEVPM_AUTO_UPDATE=1`
 *
 * Only global npm/bun installs are updated. Monorepo checkouts, `bun link`,
 * and local `node_modules` installs are ignored.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

/** How the running binary appears to have been installed. */
export type InstallKind = "npm-global" | "bun-global" | "local" | "unknown";

export type CliUpdateConfig = {
  /** npm package name, e.g. `@getdevintern/code`. */
  packageName: string;
  /** CLI binary name shown in messages, e.g. `devintern`. */
  binName: string;
  /** Currently running version (from build define or package.json). */
  currentVersion: string;
  /** Whether a confirmation prompt is allowed (TTY + not automated). */
  isInteractive: boolean;
  /** Optional confirm callback; defaults to a stdin Y/n prompt. */
  confirm?: (message: string) => Promise<boolean>;
  /** argv used for flag detection and re-exec (defaults to `process.argv`). */
  argv?: string[];
  /** Absolute path of the running script (`process.argv[1]`). */
  scriptPath?: string;
  /** Env vars to read (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Package-specific opt-out env var, e.g. `DEVINTERN_NO_UPDATE`. */
  noUpdateEnv?: string;
  /** Package-specific auto-update env var, e.g. `DEVINTERN_AUTO_UPDATE`. */
  autoUpdateEnv?: string;
  /** Override home directory (tests). */
  homeDir?: string;
  /** Override cache file path (tests). */
  cachePath?: string;
  /** Minimum ms between registry checks (default 24h). */
  checkIntervalMs?: number;
  /** Registry fetch timeout in ms (default 3000). */
  fetchTimeoutMs?: number;
  /** Injected fetch (tests). */
  fetchFn?: typeof fetch;
  /** Injected installer (tests); return true on success. */
  installFn?: (opts: {
    packageManager: "npm" | "bun";
    packageName: string;
    version: string;
  }) => boolean | Promise<boolean>;
  /** Injected re-exec (tests); return without exiting to keep tests alive. */
  reexecFn?: (argv: string[]) => void;
  /** Injected logger (tests). */
  log?: (message: string) => void;
  /** Skip install-kind detection and force a kind (tests). */
  installKind?: InstallKind;
  /** Wall-clock now (tests). */
  now?: () => number;
};

type CacheEntry = {
  checkedAt: number;
  latestVersion?: string;
  declinedVersion?: string;
  notifiedVersion?: string;
};

type UpdateCache = Record<string, CacheEntry>;

const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 3000;
const NPM_LATEST_URL = (packageName: string) => `https://registry.npmjs.org/${packageName}/latest`;

/**
 * Compare two semver strings (major.minor.patch). Prerelease/build metadata
 * on either side is ignored. Returns true when `latest` is strictly newer.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

/**
 * Parse a semver-ish version into `[major, minor, patch]`.
 * Returns null when the string is not a usable version.
 */
export function parseSemver(version: string): [number, number, number] | null {
  const cleaned = version.trim().replace(/^v/i, "").split("-")[0]?.split("+")[0];
  if (!cleaned) return null;
  const parts = cleaned.split(".");
  if (parts.length < 2) return null;
  const nums = [parts[0], parts[1], parts[2] ?? "0"].map((p) => Number.parseInt(p ?? "", 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/**
 * Classify how the running script was installed.
 *
 * Global bun installs live under `~/.bun/install/global`. Global npm installs
 * typically live under a `.../lib/node_modules/@scope/pkg` prefix. Monorepo
 * sources and local project `node_modules` are treated as local (no update).
 */
export function detectInstallKind(options: {
  scriptPath: string;
  packageName: string;
  homeDir?: string;
}): InstallKind {
  const scriptPath = options.scriptPath.trim();
  if (!scriptPath) return "unknown";

  let resolved: string;
  try {
    resolved = resolve(scriptPath);
  } catch {
    return "unknown";
  }

  // Source / linked monorepo paths
  if (/[/\\]packages[/\\](code|pm)[/\\]/.test(resolved)) {
    return "local";
  }

  const home = options.homeDir ?? homedir();
  const bunGlobalRoot = join(home, ".bun", "install", "global");
  if (resolved.startsWith(bunGlobalRoot + sep) || resolved.startsWith(bunGlobalRoot)) {
    return "bun-global";
  }

  const pkgMarker = `${sep}node_modules${sep}${options.packageName}${sep}`;
  const pkgMarkerAlt = `/node_modules/${options.packageName}/`;
  const hasPackageMarker = resolved.includes(pkgMarker) || resolved.includes(pkgMarkerAlt);

  // Classic npm global prefix: .../lib/node_modules/@scope/pkg/...
  if (
    hasPackageMarker &&
    (/[/\\]lib[/\\]node_modules[/\\]/.test(resolved) ||
      /[/\\]npm[/\\]node_modules[/\\]/.test(resolved))
  ) {
    return "npm-global";
  }

  // Local project install or anything else under node_modules
  if (hasPackageMarker || resolved.includes(`${sep}node_modules${sep}`)) {
    return "local";
  }

  // `bun run src/index.ts` / direct source execution
  if (resolved.endsWith(".ts") || resolved.endsWith(".tsx")) {
    return "local";
  }

  return "unknown";
}

/**
 * Whether argv/env say to skip the update check entirely.
 */
export function shouldSkipUpdateCheck(options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  noUpdateEnv?: string;
}): boolean {
  const { argv, env, noUpdateEnv } = options;
  if (argv.includes("--no-update")) return true;
  if (argv.includes("--help") || argv.includes("-h")) return true;
  if (argv.includes("--version") || argv.includes("-V")) return true;

  if (env.DEVINTERN_NO_UPDATE === "1" || env.DEVINTERN_NO_UPDATE === "true") {
    return true;
  }
  if (noUpdateEnv) {
    const value = env[noUpdateEnv];
    if (value === "1" || value === "true") return true;
  }
  return false;
}

/**
 * Fetch the `latest` version string from the npm registry.
 * Returns null on any failure (network, parse, timeout).
 */
export async function fetchLatestVersion(
  packageName: string,
  options?: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<string | null> {
  const fetchFn = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(NPM_LATEST_URL(packageName), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function defaultCachePath(homeDir: string): string {
  return join(homeDir, ".devintern", "update-check.json");
}

function readCache(cachePath: string): UpdateCache {
  try {
    if (!existsSync(cachePath)) return {};
    const raw = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as UpdateCache;
  } catch {
    return {};
  }
}

function writeCache(cachePath: string, cache: UpdateCache): void {
  try {
    mkdirSync(resolve(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch {
    // Cache is best-effort; never fail the CLI for this.
  }
}

async function defaultConfirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} (Y/n): `);
  const rl = createInterface({ input: process.stdin });
  try {
    const line = await new Promise<string | null>((resolveLine) => {
      let settled = false;
      rl.once("line", (value) => {
        settled = true;
        resolveLine(value);
      });
      rl.once("close", () => {
        if (!settled) resolveLine(null);
      });
    });
    if (line === null) return false;
    const trimmed = line.trim().toLowerCase();
    if (trimmed === "" || trimmed === "y" || trimmed === "yes") return true;
    if (trimmed === "n" || trimmed === "no") return false;
    return false;
  } finally {
    rl.close();
  }
}

function defaultInstall(opts: {
  packageManager: "npm" | "bun";
  packageName: string;
  version: string;
}): boolean {
  const spec = `${opts.packageName}@${opts.version}`;
  const result =
    opts.packageManager === "bun"
      ? spawnSync("bun", ["install", "-g", spec], { stdio: "inherit", encoding: "utf8" })
      : spawnSync("npm", ["install", "-g", spec], { stdio: "inherit", encoding: "utf8" });
  return result.status === 0;
}

function defaultReexec(argv: string[]): void {
  // argv[0] is the runtime (node/bun); argv.slice(1) is the script + user args.
  const result = spawnSync(argv[0]!, argv.slice(1), {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function packageManagerForKind(kind: InstallKind): "npm" | "bun" | null {
  if (kind === "bun-global") return "bun";
  if (kind === "npm-global") return "npm";
  return null;
}

/**
 * Check npm for a newer CLI version and optionally update the global install.
 *
 * Never throws; failures are swallowed so the user's command still runs.
 * When an update is installed, re-execs (or calls `reexecFn`) and does not
 * return under the default re-exec implementation.
 *
 * @returns `"updated"` if an update was applied, `"skipped"` otherwise.
 */
export async function maybeOfferCliUpdate(config: CliUpdateConfig): Promise<"updated" | "skipped"> {
  const log = config.log ?? ((message: string) => console.log(message));
  const argv = config.argv ?? process.argv;
  const env = config.env ?? process.env;
  const now = config.now ?? Date.now;
  const homeDir = config.homeDir ?? homedir();
  const cachePath = config.cachePath ?? defaultCachePath(homeDir);
  const checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const currentVersion = config.currentVersion;

  try {
    if (shouldSkipUpdateCheck({ argv, env, noUpdateEnv: config.noUpdateEnv })) {
      return "skipped";
    }

    // Dev / unset version — never treat as stale.
    if (!currentVersion || currentVersion === "0.0.0") {
      return "skipped";
    }

    const scriptPath = config.scriptPath ?? argv[1] ?? "";
    const installKind =
      config.installKind ??
      detectInstallKind({
        scriptPath,
        packageName: config.packageName,
        homeDir,
      });
    const packageManager = packageManagerForKind(installKind);
    if (!packageManager) {
      return "skipped";
    }

    const cache = readCache(cachePath);
    const entry = cache[config.packageName] ?? { checkedAt: 0 };
    const age = now() - (entry.checkedAt || 0);
    let latestVersion = entry.latestVersion;

    if (age >= checkIntervalMs || !latestVersion) {
      const fetched = await fetchLatestVersion(config.packageName, {
        fetchFn: config.fetchFn,
        timeoutMs: config.fetchTimeoutMs,
      });
      entry.checkedAt = now();
      if (fetched) {
        entry.latestVersion = fetched;
        latestVersion = fetched;
      }
      cache[config.packageName] = entry;
      writeCache(cachePath, cache);
    }

    if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
      return "skipped";
    }

    // User already declined this exact version in a prior interactive prompt.
    if (entry.declinedVersion === latestVersion && config.isInteractive) {
      return "skipped";
    }

    const autoUpdate =
      env.DEVINTERN_AUTO_UPDATE === "1" ||
      env.DEVINTERN_AUTO_UPDATE === "true" ||
      (config.autoUpdateEnv != null &&
        (env[config.autoUpdateEnv] === "1" || env[config.autoUpdateEnv] === "true"));

    const installCmd =
      packageManager === "bun"
        ? `bun install -g ${config.packageName}@${latestVersion}`
        : `npm install -g ${config.packageName}@${latestVersion}`;

    let shouldInstall = false;

    if (config.isInteractive) {
      log(`⬆  ${config.binName} ${latestVersion} is available (current: ${currentVersion}).`);
      const confirm = config.confirm ?? defaultConfirm;
      const accepted = await confirm(`Update ${config.binName} now?`);
      if (!accepted) {
        entry.declinedVersion = latestVersion;
        cache[config.packageName] = entry;
        writeCache(cachePath, cache);
        log(`   Skipped. Update later with: ${installCmd}`);
        return "skipped";
      }
      shouldInstall = true;
    } else if (autoUpdate) {
      log(
        `⬆  Auto-updating ${config.binName} ${currentVersion} → ${latestVersion} (${config.autoUpdateEnv ?? "DEVINTERN_AUTO_UPDATE"} is set)...`,
      );
      shouldInstall = true;
    } else {
      // Safe default for non-interactive: never mutate the global install.
      if (entry.notifiedVersion !== latestVersion) {
        log(
          `ℹ  ${config.binName} ${latestVersion} is available (current: ${currentVersion}). Non-interactive session — skipping update. Run: ${installCmd}`,
        );
        entry.notifiedVersion = latestVersion;
        cache[config.packageName] = entry;
        writeCache(cachePath, cache);
      }
      return "skipped";
    }

    if (!shouldInstall) return "skipped";

    const install = config.installFn ?? defaultInstall;
    const ok = await install({
      packageManager,
      packageName: config.packageName,
      version: latestVersion,
    });

    if (!ok) {
      log(`⚠️  Failed to update ${config.binName}. Continuing with ${currentVersion}.`);
      log(`   Try manually: ${installCmd}`);
      return "skipped";
    }

    log(`✅ Updated ${config.binName} to ${latestVersion}. Re-running command...`);

    // Clear declined/notified so a future older pin doesn't stick.
    entry.declinedVersion = undefined;
    entry.notifiedVersion = undefined;
    entry.latestVersion = latestVersion;
    entry.checkedAt = now();
    cache[config.packageName] = entry;
    writeCache(cachePath, cache);

    const reexec = config.reexecFn ?? defaultReexec;
    reexec(argv);
    return "updated";
  } catch {
    return "skipped";
  }
}
