import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkerStatusIndicator } from "@/components/StatusStrip";
import type { WorkerStatus } from "@/lib/api";

function render(worker: WorkerStatus): string {
  return renderToStaticMarkup(createElement(WorkerStatusIndicator, { worker }));
}

test("a live worker lock shows running with its pid", () => {
  const html = render({ status: "running", pid: 4242 });

  expect(html).toContain("worker running (pid 4242)");
  // The chart color class marks the healthy state.
  expect(html).toContain("text-chart-4");
});

test("a stale worker lock (dead pid) shows stopped", () => {
  const html = render({ status: "stopped", pid: 999999999 });

  expect(html).toContain("worker stopped");
  expect(html).not.toContain("text-chart-4");
});

test("an undeterminable worker says unknown instead of claiming stopped", () => {
  const html = render({ status: "unknown" });

  // No lock file in any known location (different directory than the worker)
  // must not be reported as a stopped worker.
  expect(html).toContain("worker status unknown");
  expect(html).not.toContain("worker stopped");
  expect(html).toContain("title=");
});
