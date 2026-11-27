/**
 * Wait for a freshly published npm version to become installable.
 *
 * `npm publish` returns before every registry replica and CDN edge serves the
 * new version, so the post-release smoke test (`DEVINTERN_CLI_SOURCE=npm:<v>`)
 * polls the package document (what `bun add` reads) with backoff instead of
 * failing the moment the version is missing.
 */

export const NPM_REGISTRY = "https://registry.npmjs.org";
/** How long a just-published exact version may take to show up. */
export const DEFAULT_NPM_VISIBILITY_TIMEOUT_MS = 15 * 60_000;
/**
 * Printed when the wait gives up, so the workflow can tell "the publish has
 * not propagated yet" apart from an onboarding regression.
 */
export const NPM_NOT_VISIBLE_MARKER = "npm-not-visible:";

/** What the registry says about a package, parsed at the boundary. */
export interface NpmPackument {
  distTags: Record<string, string>;
  versions: ReadonlySet<string>;
}

/** Returns the package document, or `undefined` when the package is unknown (404). */
export type FetchPackument = (packageName: string) => Promise<NpmPackument | undefined>;

export function parsePackument(data: unknown): NpmPackument {
  if (typeof data !== "object" || data === null) {
    throw new Error("npm registry: package document is not an object");
  }
  const record = data as Record<string, unknown>;
  const distTags: Record<string, string> = {};
  const rawTags = record["dist-tags"];
  if (typeof rawTags === "object" && rawTags !== null) {
    for (const [tag, version] of Object.entries(rawTags)) {
      if (typeof version === "string") distTags[tag] = version;
    }
  }
  const rawVersions = record.versions;
  const versions =
    typeof rawVersions === "object" && rawVersions !== null
      ? new Set(Object.keys(rawVersions))
      : new Set<string>();
  return { distTags, versions };
}

export function registryFetchPackument(registry = NPM_REGISTRY): FetchPackument {
  return async (packageName) => {
    const response = await fetch(`${registry}/${packageName.replace("/", "%2f")}`, {
      headers: {
        // The abbreviated document package managers install from.
        Accept: "application/vnd.npm.install-v1+json",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new NpmRegistryHttpError(response.status, packageName);
    return parsePackument(await response.json());
  };
}

export class NpmRegistryHttpError extends Error {
  constructor(
    readonly status: number,
    packageName: string,
  ) {
    super(`npm registry: HTTP ${status} for ${packageName}`);
    this.name = "NpmRegistryHttpError";
  }

  /** Auth and request errors will not fix themselves by waiting; 5xx, 408 and 429 may. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

/**
 * The registry answered, but never with the version. Only thrown when at least
 * one check got a registry answer, so an outage or a misconfigured registry is
 * not reported as a propagation delay.
 */
export class NpmNotVisibleError extends Error {
  constructor(
    readonly packageName: string,
    readonly version: string,
    readonly waitedMs: number,
    readonly lastStatus: string,
  ) {
    super(
      `${packageName}@${version} is not visible on npm after ${formatMinutes(waitedMs)} ` +
        `(last check: ${lastStatus}); the publish may still be propagating`,
    );
    this.name = "NpmNotVisibleError";
  }
}

export interface WaitForNpmVersionOptions {
  packageName: string;
  /** An exact version (waited for) or a dist-tag such as `latest` (resolved once). */
  spec: string;
  timeoutMs?: number;
  /** First pause between checks; doubles up to `maxDelayMs`. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  fetchPackument?: FetchPackument;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface NpmVersionVisible {
  version: string;
  waitedMs: number;
  attempts: number;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * Resolve `spec` on the registry. A dist-tag must already exist; an exact
 * version is polled with exponential backoff until it is listed or
 * `timeoutMs` passes. Transient registry errors (network, 5xx, 408, 429) are
 * retried; other HTTP errors fail at once. At the deadline it throws
 * {@link NpmNotVisibleError} if the registry ever answered, or a plain error
 * naming the last failure if every check errored.
 */
export async function waitForNpmVersion(
  options: WaitForNpmVersionOptions,
): Promise<NpmVersionVisible> {
  const {
    packageName,
    timeoutMs = DEFAULT_NPM_VISIBILITY_TIMEOUT_MS,
    initialDelayMs = 10_000,
    maxDelayMs = 60_000,
    fetchPackument = registryFetchPackument(),
    sleep = Bun.sleep,
    now = Date.now,
    log = console.log,
  } = options;
  const spec = options.spec.trim() || "latest";
  const started = now();

  if (!EXACT_VERSION.test(spec)) {
    const version = (await fetchPackument(packageName))?.distTags[spec];
    if (!version) throw new Error(`${packageName} has no "${spec}" dist-tag on the npm registry`);
    return { version, waitedMs: 0, attempts: 1 };
  }

  let delay = initialDelayMs;
  let registryAnswered = false;
  for (let attempts = 1; ; attempts++) {
    let status: string;
    try {
      const packument = await fetchPackument(packageName);
      if (packument?.versions.has(spec)) {
        const waitedMs = now() - started;
        if (attempts > 1) {
          log(`${packageName}@${spec} is visible on npm after ${formatDuration(waitedMs)}`);
        }
        return { version: spec, waitedMs, attempts };
      }
      registryAnswered = true;
      status = packument
        ? `not listed yet (latest is ${packument.distTags.latest ?? "unset"})`
        : "package not found";
    } catch (error) {
      if (error instanceof NpmRegistryHttpError && !error.retryable) throw error;
      status = error instanceof Error ? error.message : String(error);
    }
    const waitedMs = now() - started;
    const remaining = timeoutMs - waitedMs;
    if (remaining <= 0) {
      if (registryAnswered) throw new NpmNotVisibleError(packageName, spec, waitedMs, status);
      throw new Error(
        `Could not check ${packageName}@${spec} on the npm registry for ${formatMinutes(waitedMs)}; ` +
          `last error: ${status}`,
      );
    }
    const pause = Math.min(delay, remaining);
    log(
      `Waiting for ${packageName}@${spec} on npm: ${status}; ` +
        `waited ${formatDuration(waitedMs)} of ${formatMinutes(timeoutMs)}, next check in ${formatDuration(pause)}`,
    );
    await sleep(pause);
    delay = Math.min(delay * 2, maxDelayMs);
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
