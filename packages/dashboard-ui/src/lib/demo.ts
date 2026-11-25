/**
 * Demo snapshot mode: a static build of the dashboard
 * (`VITE_DASHBOARD_DEMO=1`, see `scripts/demo/build-demo.sh`) that reads
 * recorded API responses from `data/` next to `index.html` instead of a live
 * `devintern dashboard` server, so the real UI can be published as a
 * read-only demo.
 *
 * {@link installDemoFetch} routes every `/api/*` fetch to its recording and
 * refuses writes; views hide their actions with {@link isDemoMode}.
 */

import type { RunRecord } from "./api";
import {
  filterRecordedRuns,
  isRunDetailUrl,
  isRunListUrl,
  parseSnapshotMeta,
  rebaseTimestamps,
  pruneUnrecordedLineage,
  RUNS_ALL_FILE,
  SNAPSHOT_DATA_DIR,
  snapshotFile,
} from "./demo-snapshot";

/** Whether this build serves a recorded snapshot instead of a live server. */
export function isDemoMode(): boolean {
  return import.meta.env.VITE_DASHBOARD_DEMO === "1";
}

/**
 * Where the demo's call to action leads: `VITE_DASHBOARD_DEMO_CTA_URL` at
 * build time, or the DevIntern pilot page.
 */
export function demoCtaUrl(): string {
  return import.meta.env.VITE_DASHBOARD_DEMO_CTA_URL || "https://devintern.com/start/";
}

/** Message returned for any request that would change state. */
export const DEMO_READ_ONLY_MESSAGE = "This is a read-only demo; actions are disabled.";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The root-relative API URL of a fetch target, or null when it is not `/api/*`. */
function apiTarget(input: RequestInfo | URL, origin: string): string | null {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = new URL(raw, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/")) return null;
  return `${url.pathname}${url.search}`;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  return typeof input === "object" && "method" in input ? input.method.toUpperCase() : "GET";
}

export interface DemoFetchOptions {
  /** The real `fetch`, used to load recordings. */
  fetch: typeof fetch;
  /** Base the `data/` directory resolves against (the page URL). */
  baseUrl: string;
  /** The page's origin; only same-origin `/api/*` requests are routed. */
  origin: string;
  /** Viewer's clock at page load, fixed for the session so ages tick naturally. */
  loadedAt: number;
}

/**
 * A `fetch` replacement that answers `/api/*` GETs from the snapshot and
 * refuses every other method; other URLs pass through untouched.
 *
 * @param options - Real fetch, page base URL and origin, page load time
 */
export function createDemoFetch(options: DemoFetchOptions): typeof fetch {
  const { baseUrl, origin, loadedAt } = options;
  const realFetch = options.fetch;
  const load = async (file: string): Promise<unknown> => {
    const response = await realFetch(new URL(file, baseUrl));
    // Static hosts with an SPA fallback answer a missing file with the HTML
    // shell, so a non-JSON body is "not recorded", not a parse error.
    if (!response.ok) return undefined;
    try {
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  };
  let shift: Promise<number> | undefined;
  const shiftMs = (): Promise<number> => {
    shift ??= load(`${SNAPSHOT_DATA_DIR}/meta.json`).then((meta) => {
      const parsed = parseSnapshotMeta(meta);
      return parsed ? loadedAt - parsed.exportedAt : 0;
    });
    return shift;
  };
  let runs: Promise<RunRecord[]> | undefined;
  const recordedRuns = (): Promise<RunRecord[]> => {
    runs ??= load(RUNS_ALL_FILE).then((body) =>
      body && typeof body === "object" && Array.isArray((body as { runs?: unknown }).runs)
        ? (body as { runs: RunRecord[] }).runs
        : [],
    );
    return runs;
  };

  const demoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = apiTarget(input, origin);
    if (target === null) return realFetch(input, init);
    const method = requestMethod(input, init);
    if (method !== "GET" && method !== "HEAD") {
      return jsonResponse(403, { error: DEMO_READ_ONLY_MESSAGE });
    }
    const delta = await shiftMs();
    if (isRunListUrl(target)) {
      return jsonResponse(
        200,
        rebaseTimestamps(filterRecordedRuns(await recordedRuns(), target), delta),
      );
    }
    const file = snapshotFile(target);
    if (file === null) return jsonResponse(404, { error: "not part of this demo" });
    if (file.endsWith(".bin")) return realFetch(new URL(file, baseUrl), init);
    let body = await load(file);
    if (body === undefined) return jsonResponse(404, { error: "not part of this demo" });
    if (isRunDetailUrl(target)) {
      const recordedIds = new Set((await recordedRuns()).map((run) => run.id));
      body = pruneUnrecordedLineage(body, recordedIds);
    }
    return jsonResponse(200, rebaseTimestamps(body, delta));
  };
  return demoFetch as typeof fetch;
}

/** Route this page's `/api/*` fetches to the recorded snapshot. */
export function installDemoFetch(): void {
  window.fetch = createDemoFetch({
    fetch: window.fetch.bind(window),
    baseUrl: document.baseURI,
    origin: window.location.origin,
    loadedAt: Date.now(),
  });
}

/**
 * URL for an API resource loaded by the browser directly (an `<img src>`
 * or download link) rather than through `fetch`: its recorded file in demo
 * mode, the API URL itself otherwise.
 *
 * @param apiUrl - Root-relative API URL
 */
export function apiResourceUrl(apiUrl: string): string {
  if (!isDemoMode()) return apiUrl;
  return snapshotFile(apiUrl) ?? apiUrl;
}
