/**
 * Record every GET response the dashboard UI reads from a running dashboard
 * server into a snapshot directory, for the read-only demo build
 * (`VITE_DASHBOARD_DEMO=1`, see `build-demo.sh` and `src/lib/demo.ts`).
 *
 *   bun run scripts/demo/snapshot.ts <base-url> <data-dir>
 *
 * File names come from `snapshotFile()`, the same mapping the browser uses to
 * read them back. `/api/runs` is recorded once in full (`runs.all.json`); the
 * demo applies list filters and paging in the browser.
 *
 * Point this only at a dashboard whose data may be published, such as the
 * seeded demo workspace: everything it serves, transcripts included, ends up
 * in the snapshot.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RunDetailResponse, RunRecord } from "../../src/lib/api";
import { RUNS_ALL_FILE, SNAPSHOT_DATA_DIR, snapshotFile } from "../../src/lib/demo-snapshot";
import type { DemoSnapshotMeta } from "../../src/lib/demo-snapshot";

const [baseUrl, dataDir] = process.argv.slice(2);
if (!baseUrl || !dataDir) {
  console.error("usage: snapshot.ts <base-url> <data-dir>");
  process.exit(1);
}

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

/** Write into `<data-dir>/…`, where `file` is a `data/…` path from `snapshotFile()`. */
function write(file: string, body: string | Uint8Array): void {
  const path = join(dataDir, file.slice(SNAPSHOT_DATA_DIR.length + 1));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(new URL(url, baseUrl));
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function record(url: string): Promise<unknown> {
  const file = snapshotFile(url);
  if (!file) throw new Error(`not an API URL: ${url}`);
  const body = await getJson<unknown>(url);
  write(file, JSON.stringify(body));
  return body;
}

const exportedAt = Date.now();
for (const url of FIXED_URLS) await record(url);

const runs: RunRecord[] = [];
for (let offset = 0; ; offset += RUN_PAGE) {
  const page = await getJson<{ runs: RunRecord[]; total: number }>(
    `/api/runs?limit=${RUN_PAGE}&offset=${offset}`,
  );
  runs.push(...page.runs);
  if (page.runs.length < RUN_PAGE || runs.length >= page.total) break;
}
write(RUNS_ALL_FILE, JSON.stringify({ runs, total: runs.length }));

let files = 0;
for (const run of runs) {
  const detail = (await record(`/api/runs/${run.id}`)) as RunDetailResponse;
  await record(`/api/runs/${run.id}/harness-logs`);
  await record(`/api/runs/${run.id}/artifacts`);
  for (const log of detail.harnessLogs ?? []) {
    await record(`/api/runs/${run.id}/harness-logs/${encodeURIComponent(log.name)}`);
    files += 1;
  }
  for (const artifact of detail.artifacts ?? []) {
    if (!artifact.available) continue;
    await record(`/api/runs/${run.id}/artifacts/${artifact.id}`);
    const rawUrl = `/api/runs/${run.id}/artifacts/${artifact.id}/file`;
    const response = await fetch(new URL(rawUrl, baseUrl));
    if (response.ok)
      write(snapshotFile(rawUrl) as string, new Uint8Array(await response.arrayBuffer()));
    files += 1;
  }
}

const meta: DemoSnapshotMeta = { exportedAt };
write(`${SNAPSHOT_DATA_DIR}/meta.json`, JSON.stringify(meta));
console.log(
  `Recorded ${FIXED_URLS.length} endpoints, ${runs.length} runs, ${files} transcripts/artifacts into ${dataDir}`,
);
