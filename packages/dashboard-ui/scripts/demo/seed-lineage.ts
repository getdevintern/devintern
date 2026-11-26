/**
 * Run-lineage part of the demo seed (see `seed.ts`): the latest docs-drift
 * run delegated two ad-hoc tasks with `devintern worker add` (one merged, one
 * still queued) and filed a tracker ticket, so the run detail page shows
 * "Spawned work" on the automation run and "Sourced from" on the child.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { InjectedTaskStore } from "../../../code/src/lib/state/injected-tasks";
import type { RunOutputRecord } from "../../../code/src/lib/state/run-outputs";
import type { RunStore } from "../../../code/src/lib/state/run-recorder";

/** Automation whose latest run delegated the demo's ad-hoc tasks. */
export const DELEGATING_AUTOMATION = "docs-drift";

/** The delegated task that already ran (seeded as a regular demo run). */
export const DELEGATED_RUN = {
  key: "local-document-the-csv-export-flag",
  title: "Document the CSV export flag",
  repo: "web",
  pr: 1883,
} as const;

const QUEUED_TASK = {
  key: "local-refresh-the-sdk-quickstart",
  title: "Refresh the SDK quickstart",
  repo: "sdk",
};

const TICKET = {
  key: "PRD-223",
  title: "Decide the support policy for archived projects in exports",
};

/**
 * Write the injected-task rows (with their parent run) and the parent's
 * ingested outputs records.
 */
export function seedLineage(input: {
  db: Database;
  store: RunStore;
  dbPath: string;
  workspaceDir: string;
  parentRunId: number;
  createdAt: number;
}): void {
  const queue = new InjectedTaskStore(input.dbPath);
  const injectedDir = join(input.workspaceDir, "injected");
  mkdirSync(injectedDir, { recursive: true });
  const outputs: RunOutputRecord[] = [];
  for (const task of [
    { ...DELEGATED_RUN, status: "done" },
    { ...QUEUED_TASK, status: "pending" },
  ]) {
    const taskFile = join(injectedDir, `${task.key}.md`);
    writeFileSync(taskFile, `---\nkey: ${task.key}\n---\n\n# ${task.title}\n`);
    const { task: row } = queue.enqueue({
      taskKey: task.key,
      repo: task.repo,
      title: task.title,
      body: "",
      taskFile,
      parentRunId: input.parentRunId,
      createdAt: input.createdAt,
    });
    input.db.run("UPDATE injected_tasks SET status = ? WHERE id = ?", [task.status, row.id]);
    outputs.push({ kind: "injected_task", id: row.id, taskKey: task.key, title: task.title });
  }
  outputs.push({
    kind: "tracker_issue",
    tracker: "linear",
    key: TICKET.key,
    url: `https://linear.app/acme/issue/${TICKET.key}`,
    title: TICKET.title,
  });
  input.store.addRunOutputs(input.parentRunId, outputs);
  queue.close();
}
