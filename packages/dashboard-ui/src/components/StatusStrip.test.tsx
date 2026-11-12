import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WorkerStatusIndicator,
  queueLabel,
  queueTitle,
  showMissingDatabaseBanner,
} from "@/components/StatusStrip";
import type { WorkerResponse, WorkerStatus } from "@/lib/api";

function render(worker: WorkerStatus): string {
  return renderToStaticMarkup(createElement(WorkerStatusIndicator, { worker }));
}

const mixedQueue: WorkerResponse["queue"] = {
  pending: 1,
  processing: 0,
  failed: 0,
  injected: { pending: 2, running: 1 },
  retries: { pending: 1, running: 0 },
};

test("a live worker lock shows running with its pid", () => {
  const html = render({ status: "running", pid: 4242 });

  expect(html).toContain("worker running");
  expect(html).toContain(" (pid 4242)");
  // The running state drives the green chip styling.
  expect(html).toContain('data-state="running"');
});

test("a stale worker lock (dead pid) shows stopped", () => {
  const html = render({ status: "stopped", pid: 999999999 });

  expect(html).toContain("worker stopped");
  expect(html).toContain('data-state="stopped"');
});

test("an undeterminable worker says unknown instead of claiming stopped", () => {
  const html = render({ status: "unknown" });

  // No lock file in any known location (different directory than the worker)
  // must not be reported as a stopped worker.
  expect(html).toContain("worker status unknown");
  expect(html).not.toContain("worker stopped");
  expect(html).toContain("title=");
});

test("the queued count includes relay deliveries, ad-hoc tasks, and scheduled retries", () => {
  expect(queueLabel(mixedQueue)).toBe("5 queued");

  const title = queueTitle(mixedQueue);
  expect(title).toContain("1 relay delivery");
  expect(title).toContain("3 ad-hoc tasks");
  expect(title).toContain("1 scheduled retry");
});

test("failed deliveries are appended to the queued count and breakdown", () => {
  const queue: WorkerResponse["queue"] = { ...mixedQueue, failed: 2 };

  expect(queueLabel(queue)).toBe("5 queued, 2 failed");
  expect(queueTitle(queue)).toContain("2 failed deliveries");
});

test("queued workspace work suppresses the no-database banner", () => {
  // A fresh project can have no history DB while the workspace worker's queue
  // DB already holds pending injected rows.
  expect(showMissingDatabaseBanner({ dbMissing: true, queueDbMissing: false })).toBe(false);
  // Only when BOTH databases are absent does the banner make sense.
  expect(showMissingDatabaseBanner({ dbMissing: true, queueDbMissing: true })).toBe(true);
  expect(showMissingDatabaseBanner({ dbMissing: false, queueDbMissing: true })).toBe(false);
  expect(showMissingDatabaseBanner({ dbMissing: false, queueDbMissing: false })).toBe(false);
});
