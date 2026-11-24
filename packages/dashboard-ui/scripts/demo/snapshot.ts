/**
 * Record every GET response the dashboard UI reads from a running dashboard
 * server into a snapshot directory, for the read-only demo build
 * (`VITE_DASHBOARD_DEMO=1`, see `build-demo.sh` and `src/lib/demo.ts`).
 *
 *   bun run scripts/demo/snapshot.ts <base-url> <data-dir> [options]
 *
 * Options (for a recording of a real workspace, see `copy-workspace.ts`):
 *   --scrub                 scrub every response and fail on anything left
 *                           that looks like a credential (see `scrub.ts`)
 *   --secrets-from <file>   dotenv file whose values are secrets (repeatable)
 *   --deny <name>           name that must not appear, e.g. a private repo
 *                           (repeatable); transcripts and artifacts naming
 *                           one are dropped, other text is rewritten
 *   --skip-artifact-kind <kind>  leave artifacts of this kind out (repeatable),
 *                           e.g. `debug` dumps
 *   --report <file>         write what was dropped and why as JSON
 *
 * File names come from `snapshotFile()`, the same mapping the browser uses to
 * read them back. `/api/runs` is recorded once in full (`runs.all.json`); the
 * demo applies list filters and paging in the browser.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type {
  HarnessLogFile,
  RunDetailResponse,
  RunRecord,
  TaskArtifactFile,
} from "../../src/lib/api";
import { RUNS_ALL_FILE, SNAPSHOT_DATA_DIR, snapshotFile } from "../../src/lib/demo-snapshot";
import type { DemoSnapshotMeta } from "../../src/lib/demo-snapshot";
import { createScrubber, loadSecretValues, scrubJson } from "./scrub";

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    scrub: { type: "boolean", default: false },
    "secrets-from": { type: "string", multiple: true, default: [] },
    deny: { type: "string", multiple: true, default: [] },
    "skip-artifact-kind": { type: "string", multiple: true, default: [] },
    report: { type: "string" },
  },
});
const [baseUrl, dataDir] = positionals;
if (!baseUrl || !dataDir) {
  console.error(
    "usage: snapshot.ts <base-url> <data-dir> [--scrub] [--secrets-from f] [--deny n] [--report f]",
  );
  process.exit(1);
}

const scrubber = flags.scrub
  ? createScrubber({ secretValues: loadSecretValues(flags["secrets-from"]), deny: flags.deny })
  : null;

/** Fixed GET endpoints the views poll (query variants included). */
const FIXED_URLS = [
  "/api/health",
  "/api/overview",
  "/api/worker",
  "/api/queue",
  "/api/task-activity",
  "/api/sources",
  "/api/automations",
  "/api/workspace",
  "/api/agent-prs",
  "/api/agent-prs?state=merged",
  ...["all", "error", "warn"].map((level) => `/api/logs?level=${level}`),
  ...["7d", "30d", "90d", "all"].map((window) => `/api/stats?window=${window}`),
];
const RUN_PAGE = 200;
/** Raw artifact files kept as bytes: images up to this size (text is re-served scrubbed). */
const MAX_IMAGE_BYTES = 1_500_000;

interface Finding {
  url: string;
  reason: string;
}
const dropped: Finding[] = [];
const leaks: Finding[] = [];

/** Write into `<data-dir>/…`, where `file` is a `data/…` path from `snapshotFile()`. */
function write(file: string, body: string | Uint8Array): void {
  const path = join(dataDir as string, file.slice(SNAPSHOT_DATA_DIR.length + 1));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(new URL(url, baseUrl));
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Markdown artifacts link sibling files as `/api/runs/:id/artifacts/:id/file`,
 * which an `<img>` loads without going through fetch: point them at the
 * recorded file, relative to the page.
 */
function relinkArtifactFiles(text: string): string {
  return text.replace(
    /\/api\/runs\/\d+\/artifacts\/[a-f0-9-]{36}\/file/g,
    (url) => snapshotFile(url) ?? url,
  );
}

/** Scrub a response body; a leak left after scrubbing fails the recording. */
function clean<T>(url: string, body: T): T {
  if (!scrubber) return body;
  const scrubbed = scrubJson(body, scrubber.scrub) as T;
  const found = scrubber.findLeaks(JSON.stringify(scrubbed));
  if (found.length > 0) leaks.push({ url, reason: found.join(", ") });
  return scrubbed;
}

function save(url: string, body: unknown): void {
  const file = snapshotFile(url);
  if (!file) throw new Error(`not an API URL: ${url}`);
  write(file, JSON.stringify(clean(url, body)));
}

/**
 * A transcript or artifact body, scrubbed, or null when it must be left out:
 * it names a denied repository, or still looks leaky after scrubbing.
 */
function cleanContent<T>(url: string, body: T): T | null {
  if (!scrubber) return body;
  if (scrubber.mentionsDenied(JSON.stringify(body))) {
    dropped.push({ url, reason: "names a denied repository" });
    return null;
  }
  const scrubbed = scrubJson(body, scrubber.scrub) as T;
  const found = scrubber.findLeaks(JSON.stringify(scrubbed));
  if (found.length > 0) {
    dropped.push({ url, reason: found.join(", ") });
    return null;
  }
  return scrubbed;
}

const exportedAt = Date.now();
for (const url of FIXED_URLS) save(url, await getJson<unknown>(url));

const runs: RunRecord[] = [];
for (let offset = 0; ; offset += RUN_PAGE) {
  const page = await getJson<{ runs: RunRecord[]; total: number }>(
    `/api/runs?limit=${RUN_PAGE}&offset=${offset}`,
  );
  runs.push(...page.runs);
  if (page.runs.length < RUN_PAGE || runs.length >= page.total) break;
}
write(RUNS_ALL_FILE, JSON.stringify(clean("/api/runs", { runs, total: runs.length })));

let kept = 0;
for (const run of runs) {
  const detail = await getJson<RunDetailResponse>(`/api/runs/${run.id}`);

  const logs: HarnessLogFile[] = [];
  for (const log of detail.harnessLogs ?? []) {
    const url = `/api/runs/${run.id}/harness-logs/${encodeURIComponent(log.name)}`;
    const body = cleanContent(url, await getJson<unknown>(url));
    if (body === null) continue;
    save(url, body);
    logs.push(log);
    kept += 1;
  }

  const artifacts: TaskArtifactFile[] = [];
  for (const artifact of detail.artifacts ?? []) {
    if (flags["skip-artifact-kind"].includes(artifact.kind)) continue;
    if (!artifact.available) {
      artifacts.push(artifact);
      continue;
    }
    const url = `/api/runs/${run.id}/artifacts/${artifact.id}`;
    const raw = await getJson<{ content?: string | null }>(url);
    const body = cleanContent(url, {
      ...raw,
      ...(typeof raw.content === "string" ? { content: relinkArtifactFiles(raw.content) } : {}),
    });
    if (body === null) continue;
    save(url, body);
    const rawUrl = `${url}/file`;
    const rawFile = snapshotFile(rawUrl) as string;
    if (typeof body.content === "string") {
      // Text is shown from its recorded content; the demo offers no download.
    } else if (artifact.mediaType.startsWith("image/") && artifact.size <= MAX_IMAGE_BYTES) {
      const response = await fetch(new URL(rawUrl, baseUrl));
      if (response.ok) write(rawFile, new Uint8Array(await response.arrayBuffer()));
    } else {
      // Bytes that cannot be scrubbed or are too large: listed, but unavailable.
      dropped.push({ url: rawUrl, reason: `not recorded: ${artifact.mediaType}` });
      artifacts.push({ ...artifact, available: false });
      continue;
    }
    artifacts.push(artifact);
    kept += 1;
  }

  // Only list what was recorded, so the UI never offers a missing file.
  save(`/api/runs/${run.id}`, { ...detail, harnessLogs: logs, artifacts });
  save(`/api/runs/${run.id}/harness-logs`, { harnessLogs: logs });
  save(`/api/runs/${run.id}/artifacts`, { artifacts });
}

const meta: DemoSnapshotMeta = { exportedAt };
write(`${SNAPSHOT_DATA_DIR}/meta.json`, JSON.stringify(meta));
if (flags.report) writeFileSync(flags.report, JSON.stringify({ dropped, leaks }, null, 2));
console.log(
  `Recorded ${FIXED_URLS.length} endpoints, ${runs.length} runs, ${kept} transcripts/artifacts ` +
    `(${dropped.length} dropped) into ${dataDir}`,
);
if (leaks.length > 0) {
  console.error(`Scrubbing left ${leaks.length} possible leak(s); not safe to publish:`);
  for (const leak of leaks.slice(0, 20)) console.error(`  ${leak.url}: ${leak.reason}`);
  process.exit(2);
}
