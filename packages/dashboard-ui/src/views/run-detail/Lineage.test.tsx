import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RunLineageParent, SpawnedWork } from "@/lib/api";
import { SourcedFrom, SpawnedWorkSection } from "./Lineage";
import {
  groupSpawned,
  hasSpawnedWork,
  queueStatusLabel,
  safeHref,
  sourcedFromLabel,
} from "./lineage-labels";

const DELEGATED: RunLineageParent = {
  runId: 871,
  origin: "scheduled",
  status: "succeeded",
  relation: "delegated",
  automationId: "onboarding-improvements",
};

const SPAWNED: SpawnedWork[] = [
  {
    kind: "delegated_task",
    id: 132,
    taskKey: "local-fix-copy",
    title: "Fix onboarding copy",
    status: "done",
    latestRunId: 880,
    latestRunStatus: "succeeded",
    prNumber: 261,
    prUrl: "https://github.com/acme/web/pull/261",
  },
  { kind: "delegated_task", id: 133, taskKey: "local-queued", status: "pending" },
  {
    kind: "tracker_issue",
    key: "DEV-210",
    tracker: "jira",
    url: "https://acme.atlassian.net/browse/DEV-210",
    title: "Explain workspace setup",
  },
  { kind: "tracker_issue", key: "DEV-211", url: "javascript:alert(1)" },
  {
    kind: "follow_up_run",
    runId: 890,
    origin: "ci_fix",
    status: "failed",
    startedAt: 1_800_000_000_000,
  },
];

describe("lineage labels", () => {
  test("labels delegated and follow-up sources", () => {
    expect(sourcedFromLabel(DELEGATED)).toBe("Run #871 · onboarding-improvements · delegated");
    expect(
      sourcedFromLabel({
        runId: 812,
        origin: "task",
        status: "succeeded",
        relation: "follow_up",
        prNumber: 260,
      }),
    ).toBe("Run #812 · follow-up on PR #260");
    expect(
      sourcedFromLabel({ runId: 5, origin: "local", status: "failed", relation: "delegated" }),
    ).toBe("Run #5 · delegated");
  });

  test("groups spawned work by kind", () => {
    const groups = groupSpawned(SPAWNED);
    expect(groups.tasks).toHaveLength(2);
    expect(groups.issues).toHaveLength(2);
    expect(groups.followUps).toHaveLength(1);
    expect(hasSpawnedWork(groupSpawned([]))).toBe(false);
    expect(hasSpawnedWork(groupSpawned(undefined))).toBe(false);
  });

  test("queue status and link safety helpers", () => {
    expect(queueStatusLabel("pending")).toBe("Queued");
    expect(queueStatusLabel(undefined)).toBe("Unknown");
    expect(safeHref("https://x.test/a")).toBe("https://x.test/a");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("not a url")).toBeUndefined();
  });
});

describe("lineage components", () => {
  test("SourcedFrom links the parent run", () => {
    const html = renderToStaticMarkup(createElement(SourcedFrom, { parent: DELEGATED }));
    expect(html).toContain('href="#/runs/871"');
    expect(html).toContain("Run #871 · onboarding-improvements · delegated");
  });

  test("SpawnedWorkSection lists tasks, tickets, and follow-ups", () => {
    const html = renderToStaticMarkup(createElement(SpawnedWorkSection, { spawned: SPAWNED }));
    expect(html).toContain("Spawned work");
    expect(html).toContain('href="#/runs/880"');
    expect(html).toContain("Fix onboarding copy");
    expect(html).toContain('href="https://github.com/acme/web/pull/261"');
    expect(html).toContain("Queued");
    expect(html).toContain('href="https://acme.atlassian.net/browse/DEV-210"');
    expect(html).toContain("DEV-211");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#/runs/890"');
    expect(html).toContain("CI fix");
  });

  test("SpawnedWorkSection renders nothing when the run spawned nothing", () => {
    expect(renderToStaticMarkup(createElement(SpawnedWorkSection, { spawned: [] }))).toBe("");
    expect(renderToStaticMarkup(createElement(SpawnedWorkSection, { spawned: undefined }))).toBe(
      "",
    );
  });
});
