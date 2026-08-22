import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, expect } from "bun:test";

import { RepoActivityChips } from "@/components/StatusStrip";
import type { FleetStatus } from "@/lib/api";

const baseFleet: FleetStatus = {
  parallel: true,
  maxConcurrency: 4,
  active: 0,
  stale: false,
  pid: process.pid,
  updatedAt: Date.now(),
  repos: [],
};

function render(fleet: FleetStatus): string {
  return renderToStaticMarkup(createElement(RepoActivityChips, { fleet }));
}

test("renders aggregate concurrency and per-repo activity", () => {
  const html = render({
    ...baseFleet,
    repos: [
      { repo: "backend", status: "running", label: "BACK-12", startedAt: 1 },
      { repo: "frontend", status: "queued", label: "WEB-3" },
      { repo: "docs", status: "idle" },
    ],
  });

  // The strip derives the active count from its rows.
  expect(html).toContain("1/4 repos active");
  expect(html).toContain("backend ▸ BACK-12");
  expect(html).toContain("frontend");
  expect(html).toContain("(queued)");
});

test("serial mode labels the strip", () => {
  const html = render({ ...baseFleet, parallel: false, repos: [{ repo: "a", status: "idle" }] });
  expect(html).toContain("(serial)");
});

test("stale snapshots flag dead workers and stale repos", () => {
  const html = render({
    ...baseFleet,
    stale: true,
    repos: [
      { repo: "backend", status: "stale", label: "BACK-9" },
      { repo: "docs", status: "idle" },
    ],
  });
  expect(html).toContain("fleet stale");
  expect(html).not.toContain("repos active");
  expect(html).toContain("backend (stale)");
});
