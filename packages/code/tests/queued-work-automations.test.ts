import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { DashboardAutomationView } from "../src/lib/observability/dashboard-automation-view";
import {
  collectQueuedWork,
  waitingAutomationToQueuedItem,
} from "../src/lib/observability/queued-work";

function view(extra: Partial<DashboardAutomationView> = {}): DashboardAutomationView {
  return {
    id: "execution-retro",
    kind: "automation",
    enabled: true,
    schedule: "0 13 * * 0",
    repo: "devintern",
    prompt: "p",
    openPr: false,
    runFilter: { automationId: "execution-retro" },
    ...extra,
  };
}

describe("waiting automations in the queued work list", () => {
  test("maps an occurrence waiting for a slot to a queued item", () => {
    const item = waitingAutomationToQueuedItem(
      view({
        activity: {
          state: "waiting",
          since: 1_000,
          trigger: "manual",
          reason: "waiting for the devintern checkout, which another run is using",
        },
      }),
    );
    expect(item).toEqual({
      id: "automation:execution-retro",
      kind: "automation",
      title: "execution-retro",
      repo: "devintern",
      actor: "Run now",
      createdAt: 1_000,
      message: "waiting for the devintern checkout, which another run is using",
      automationId: "execution-retro",
    });
  });

  test("ignores idle and running automations", () => {
    expect(waitingAutomationToQueuedItem(view())).toBeNull();
    expect(
      waitingAutomationToQueuedItem(
        view({ activity: { state: "running", since: 1, trigger: "scheduled" } }),
      ),
    ).toBeNull();
  });

  test("lists waiting automations beside the durable queues and counts them", () => {
    const dir = mkdtempSync(join(tmpdir(), "queued-automations-"));
    try {
      const dbPath = join(dir, "missing.db");
      const body = collectQueuedWork({
        dbPath,
        queueDbPath: dbPath,
        listInjected: () => [],
        lookupRun: () => null,
        pendingTotal: 0,
        listAutomations: () => [
          view({ activity: { state: "waiting", since: 5, trigger: "scheduled" } }),
          view({ id: "log-triage" }),
        ],
      });
      expect(body.total).toBe(1);
      expect(body.items.map((item) => item.id)).toEqual(["automation:execution-retro"]);
      expect(body.items[0]?.actor).toBe("schedule");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing scheduler catalog does not empty the queue", () => {
    const dir = mkdtempSync(join(tmpdir(), "queued-automations-"));
    try {
      const dbPath = join(dir, "missing.db");
      const body = collectQueuedWork({
        dbPath,
        queueDbPath: dbPath,
        listInjected: () => [],
        lookupRun: () => null,
        pendingTotal: 0,
        listAutomations: () => {
          throw new Error("scheduler unavailable");
        },
      });
      expect(body).toEqual({ items: [], total: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
