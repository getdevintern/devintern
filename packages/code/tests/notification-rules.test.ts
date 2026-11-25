import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AutomationStateStore } from "../src/lib/automation/state";
import { notifySourceHealth, UNREADABLE_THRESHOLD } from "../src/lib/notifications/event-rules";
import { normalizeCause, runSubject } from "../src/lib/notifications/run-rules";
import { listNotifications } from "../src/lib/notifications/store";
import type { Notification, NotificationKind } from "../src/lib/notifications/types";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { RUN_ID_ENV } from "../src/lib/state/run-outputs";
import { RunStore } from "../src/lib/state/run-recorder";
import type { RunMeta } from "../src/lib/state/run-recorder";
import { ScheduledRetryStore } from "../src/lib/state/run-retry";
import { WorkerState } from "../src/lib/state/worker-state";

let dir: string;
let dbPath: string;
let runs: RunStore;
let reader: Database;
// The suite may itself run inside a DevIntern run; PR registration reads this.
let inheritedRunId: string | undefined;

beforeEach(() => {
  inheritedRunId = process.env[RUN_ID_ENV];
  delete process.env[RUN_ID_ENV];
  dir = mkdtempSync(join(tmpdir(), "notification-rules-"));
  dbPath = join(dir, "queue.db");
  runs = new RunStore(dbPath);
  reader = new Database(dbPath);
});

afterEach(() => {
  if (inheritedRunId === undefined) delete process.env[RUN_ID_ENV];
  else process.env[RUN_ID_ENV] = inheritedRunId;
  reader.close();
  runs.close();
  rmSync(dir, { recursive: true, force: true });
});

function all(kind?: NotificationKind): Notification[] {
  const hasTable = reader
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notifications'")
    .get();
  if (!hasTable) return [];
  return listNotifications(reader, { ...(kind ? { kind } : {}), includeMuted: true, limit: 200 })
    .notifications;
}

function open(kind?: NotificationKind): Notification[] {
  return all(kind).filter((notification) => notification.resolvedAt === undefined);
}

function finished(
  meta: RunMeta,
  status: "succeeded" | "failed" | "escalated" | "deferred" | "abandoned",
  reason?: string,
): number {
  const id = runs.createRun(meta);
  runs.finishRun(id, status, reason);
  return id;
}

function markRead(id: number): void {
  reader.run("UPDATE notifications SET read_at = 1 WHERE id = ?", [id]);
}

describe("escalated", () => {
  test("an escalated task run notifies (high); a later success on the task resolves it", () => {
    const runId = finished(
      { origin: "task", taskKey: "DEV-1", repo: "acme/web" },
      "escalated",
      "blocked on a decision",
    );
    const [notification] = open("escalated");
    expect(notification).toMatchObject({
      severity: "high",
      runId,
      subject: "task:DEV-1",
      count: 1,
      body: "blocked on a decision",
    });
    expect(notification.title).toContain(`Run #${runId} (DEV-1)`);

    finished({ origin: "task", taskKey: "DEV-2" }, "succeeded");
    expect(open("escalated")).toHaveLength(1);
    finished({ origin: "task", taskKey: "DEV-1" }, "succeeded");
    expect(open("escalated")).toHaveLength(0);
  });

  test("auto-merge escalations with the same cause group into one row across PRs", () => {
    for (const [prNumber, path] of [
      [1, "packages/website/drafts/a.md"],
      [2, "packages/website/drafts/b.md"],
      [3, "packages/website/drafts/c.md"],
    ] as const) {
      finished(
        {
          origin: "auto_merge",
          repo: "acme/web",
          prNumber,
          prUrl: `https://github.com/acme/web/pull/${prNumber}`,
        },
        "escalated",
        `${path} matches deny pattern packages/website/**`,
      );
    }
    finished(
      {
        origin: "auto_merge",
        repo: "acme/web",
        prNumber: 4,
        prUrl: "https://github.com/acme/web/pull/4",
      },
      "escalated",
      "CI is failing",
    );
    const rows = open("escalated");
    expect(rows).toHaveLength(2);
    const deny = rows.find((row) => row.groupKey.includes("deny pattern"))!;
    expect(deny.groupKey).toBe(
      "escalated:auto_merge:acme/web:matches deny pattern packages/website/**",
    );
    expect(deny.count).toBe(3);
    expect(deny.title).toBe(
      "Auto-merge escalated 3 times: matches deny pattern packages/website/**",
    );
    expect(deny.links.filter((link) => link.url).map((link) => link.url)).toEqual([
      "https://github.com/acme/web/pull/1",
      "https://github.com/acme/web/pull/2",
      "https://github.com/acme/web/pull/3",
    ]);
  });

  test("an escalation resolves when its PR is closed or merged", () => {
    finished(
      {
        origin: "auto_merge",
        repo: "acme/web",
        prNumber: 5,
        prUrl: "https://github.com/acme/web/pull/5",
      },
      "escalated",
      "needs review",
    );
    finished(
      {
        origin: "task",
        taskKey: "DEV-9",
        repo: "acme/web",
        prNumber: 6,
        prUrl: "https://github.com/acme/web/pull/6",
      },
      "escalated",
      "agent blocked",
    );
    const state = new WorkerState(dbPath);
    try {
      state.recordAgentPr({ repo: "acme/web", prNumber: 5 });
      state.recordAgentPr({ repo: "acme/web", prNumber: 6 });
      state.markAgentPrClosed("acme/web", 5, "merged");
      expect(open("escalated").map((row) => row.subject)).toEqual(["task:DEV-9"]);
      state.markAgentPrClosed("acme/web", 6, "closed");
      expect(open("escalated")).toHaveLength(0);
    } finally {
      state.close();
    }
  });

  test("a later auto-merge success on the same PR resolves its escalation", () => {
    const pr = {
      origin: "auto_merge" as const,
      repo: "acme/web",
      prNumber: 8,
      prUrl: "https://github.com/acme/web/pull/8",
    };
    finished(pr, "escalated", "checks pending too long");
    expect(open("escalated")).toHaveLength(1);
    finished(pr, "succeeded", "merged");
    expect(open("escalated")).toHaveLength(0);
  });
});

describe("retries_exhausted", () => {
  test("a failed task run with no retry ahead notifies once per task", () => {
    const runId = finished(
      { origin: "task", taskKey: "DEV-3", repo: "acme/api" },
      "failed",
      "tests failed",
    );
    const [notification] = open("retries_exhausted");
    expect(notification).toMatchObject({
      severity: "high",
      runId,
      subject: "task:DEV-3",
      groupKey: "retries_exhausted:task:DEV-3",
    });
    // A retried finish of the same run does not double-count.
    runs.finishRun(runId, "failed", "tests failed");
    expect(open("retries_exhausted")[0].count).toBe(1);
  });

  test("a scheduled retry means no notification", () => {
    const retries = new ScheduledRetryStore(dbPath);
    try {
      retries.schedule({ taskKey: "DEV-4", actor: "dashboard" });
      finished({ origin: "task", taskKey: "DEV-4" }, "failed", "boom");
    } finally {
      retries.close();
    }
    expect(open("retries_exhausted")).toHaveLength(0);
  });

  test("deferrals, successes, and origins with their own retry budget never notify", () => {
    finished({ origin: "task", taskKey: "DEV-5" }, "deferred", "usage limit");
    finished({ origin: "task", taskKey: "DEV-6" }, "succeeded");
    finished({ origin: "ci_fix", taskKey: "DEV-7", prNumber: 1 }, "failed", "attempt 1");
    finished(
      { origin: "conflict_resolution", taskKey: "DEV-7", prNumber: 1 },
      "failed",
      "conflict",
    );
    finished({ origin: "pr_mention", prNumber: 1 }, "failed", "x");
    finished({ origin: "auto_merge", repo: "acme/web", prNumber: 1 }, "failed", "x");
    finished({ origin: "scheduled", taskKey: "occurrence-1", automationId: "nightly" }, "failed");
    expect(all()).toHaveLength(0);
  });

  test("a later success for the task resolves it", () => {
    finished({ origin: "task", taskKey: "DEV-8" }, "failed", "boom");
    expect(open("retries_exhausted")).toHaveLength(1);
    finished({ origin: "task", taskKey: "DEV-8" }, "succeeded");
    expect(open("retries_exhausted")).toHaveLength(0);
  });

  test("an ad-hoc task that runs out of deferrals notifies", () => {
    const injected = new InjectedTaskStore(dbPath);
    try {
      const { task } = injected.enqueue({
        taskKey: "local-flaky",
        repo: "web",
        title: "Flaky",
        body: "",
        taskFile: join(dir, "local-flaky.md"),
      });
      expect(injected.claimNext()?.id).toBe(task.id);
      finished({ origin: "local", taskKey: "local-flaky" }, "deferred", "usage limit");
      expect(open("retries_exhausted")).toHaveLength(0);
      injected.defer(task.id, {
        maxDeferrals: 1,
        backoffMs: () => 0,
        exhaustedMessage: "deferred 1 time in a row; giving up",
      });
    } finally {
      injected.close();
    }
    const [notification] = open("retries_exhausted");
    expect(notification).toMatchObject({ subject: "task:local-flaky" });
    expect(notification.body).toBe("deferred 1 time in a row; giving up");
  });
});

describe("automation_broke", () => {
  const automation = (key: string): RunMeta => ({
    origin: "scheduled",
    taskKey: key,
    automationId: "nightly-deps",
  });

  test("a failure right after a success notifies; repeated failures do not re-notify; the next success resolves", () => {
    finished(automation("o1"), "failed", "first run failed");
    expect(open("automation_broke")).toHaveLength(0);
    finished(automation("o2"), "succeeded");
    const brokenRun = finished(automation("o3"), "failed", "lockfile conflict");
    const [notification] = open("automation_broke");
    expect(notification).toMatchObject({
      runId: brokenRun,
      subject: "automation:nightly-deps",
      severity: "high",
      count: 1,
    });
    finished(automation("o4"), "failed", "still broken");
    expect(open("automation_broke")[0].count).toBe(1);
    finished(automation("o5"), "deferred");
    finished(automation("o6"), "succeeded");
    expect(open("automation_broke")).toHaveLength(0);
  });

  test("an ordinary automation success notifies nothing", () => {
    finished(automation("o1"), "succeeded");
    finished(automation("o2"), "succeeded");
    expect(all()).toHaveLength(0);
  });
});

describe("work_spawned", () => {
  function enqueueChild(injected: InjectedTaskStore, key: string, parentRunId: number): void {
    injected.enqueue({
      taskKey: key,
      repo: "web",
      title: key.replace("local-", ""),
      body: "",
      taskFile: join(dir, `${key}.md`),
      parentRunId,
    });
  }

  test("a run that delegated tasks and filed a ticket notifies on finish and rolls up child progress", () => {
    const parent = runs.createRun({
      origin: "scheduled",
      taskKey: "occ",
      automationId: "onboarding-improvements",
    });
    const injected = new InjectedTaskStore(dbPath);
    try {
      for (const key of ["local-a", "local-b", "local-c"]) enqueueChild(injected, key, parent);
    } finally {
      injected.close();
    }
    runs.addRunOutputs(parent, [
      { kind: "tracker_issue", tracker: "jira", key: "DEV-210", url: "https://jira.test/DEV-210" },
    ]);
    // Still running: delegation alone does not notify yet.
    expect(all("work_spawned")).toHaveLength(0);

    runs.finishRun(parent, "succeeded");
    let [notification] = open("work_spawned");
    expect(notification.title).toBe(
      `Run #${parent} (onboarding-improvements) delegated 3 tasks and filed 1 ticket`,
    );
    expect(notification.body).toBe("0/3 finished\nFiled: DEV-210");
    expect(notification.severity).toBe("normal");
    expect(notification.links.map((link) => link.taskKey ?? link.runId)).toEqual([
      parent,
      "local-a",
      "local-b",
      "local-c",
      "DEV-210",
    ]);
    markRead(notification.id);

    finished(
      {
        origin: "local",
        taskKey: "local-a",
        prNumber: 1,
        prUrl: "https://github.com/acme/web/pull/1",
      },
      "succeeded",
    );
    [notification] = open("work_spawned");
    expect(notification.body).toBe("1/3 finished: 1 PR open\nFiled: DEV-210");
    expect(notification.readAt).toBeDefined();
    expect(notification.count).toBe(1);

    finished(
      {
        origin: "local",
        taskKey: "local-b",
        prNumber: 2,
        prUrl: "https://github.com/acme/web/pull/2",
      },
      "succeeded",
    );
    finished({ origin: "local", taskKey: "local-c" }, "failed", "boom");
    [notification] = open("work_spawned");
    expect(notification.body).toBe("3/3 finished: 2 PRs open, 1 failed\nFiled: DEV-210");
    // A failed child resurfaces the rollup.
    expect(notification.readAt).toBeUndefined();
    expect(notification.links.find((link) => link.taskKey === "local-a")?.url).toBe(
      "https://github.com/acme/web/pull/1",
    );
  });

  test("a task delegated after the parent settled updates (or creates) the notification", () => {
    const parent = finished({ origin: "task", taskKey: "DEV-50" }, "succeeded");
    expect(all("work_spawned")).toHaveLength(0);
    const injected = new InjectedTaskStore(dbPath);
    try {
      enqueueChild(injected, "local-late", parent);
      expect(open("work_spawned")[0].title).toBe(`Run #${parent} (DEV-50) delegated 1 task`);
      markRead(open("work_spawned")[0].id);
      enqueueChild(injected, "local-later", parent);
    } finally {
      injected.close();
    }
    const [notification] = open("work_spawned");
    expect(notification.title).toBe(`Run #${parent} (DEV-50) delegated 2 tasks`);
    expect(notification.readAt).toBeUndefined();
    expect(notification.count).toBe(1);
  });

  test("a run that spawned nothing does not notify", () => {
    finished({ origin: "task", taskKey: "DEV-51" }, "succeeded");
    expect(all()).toHaveLength(0);
  });
});

describe("pr_opened / pr_auto_merged", () => {
  test("PRs DevIntern opens group per repo per day; re-registering an open PR is not news", () => {
    const state = new WorkerState(dbPath);
    try {
      state.recordAgentPr({ repo: "acme/web", prNumber: 10, taskKey: "DEV-10" });
      state.recordAgentPr({ repo: "acme/web", prNumber: 10, taskKey: "DEV-10" });
      expect(open("pr_opened")[0]).toMatchObject({ count: 1, title: "Opened acme/web#10" });
      state.recordAgentPr({ repo: "acme/web", prNumber: 11 });
      state.recordAgentPr({ repo: "acme/api", prNumber: 1 });
      const rows = open("pr_opened");
      expect(rows).toHaveLength(2);
      const web = rows.find((row) => row.repo === "acme/web")!;
      expect(web).toMatchObject({
        count: 2,
        title: "Opened 2 PRs in acme/web today",
        severity: "normal",
      });
      expect(web.links.map((link) => link.url)).toEqual([
        "https://github.com/acme/web/pull/10",
        "https://github.com/acme/web/pull/11",
      ]);
      // A reopened PR counts again.
      state.markAgentPrClosed("acme/api", 1, "closed");
      state.recordAgentPr({ repo: "acme/api", prNumber: 1 });
      expect(open("pr_opened").find((row) => row.repo === "acme/api")?.count).toBe(2);
    } finally {
      state.close();
    }
  });

  test("one run opening two PRs counts both", () => {
    process.env[RUN_ID_ENV] = "77";
    const state = new WorkerState(dbPath);
    try {
      state.recordAgentPr({ repo: "acme/web", prNumber: 20 });
      state.recordAgentPr({ repo: "acme/web", prNumber: 21 });
      state.recordAgentPr({ repo: "acme/web", prNumber: 21 });
    } finally {
      state.close();
    }
    expect(open("pr_opened")[0]).toMatchObject({
      count: 2,
      runId: 77,
      title: "Opened 2 PRs in acme/web today",
    });
  });

  test("auto-merged PRs group per repo per day", () => {
    for (const prNumber of [1, 2]) {
      finished(
        {
          origin: "auto_merge",
          repo: "acme/web",
          prNumber,
          prUrl: `https://github.com/acme/web/pull/${prNumber}`,
        },
        "succeeded",
        "merged",
      );
    }
    const [notification] = open("pr_auto_merged");
    expect(notification).toMatchObject({ count: 2, title: "Auto-merged 2 PRs in acme/web today" });
  });
});

describe("source_unhealthy", () => {
  function record(
    store: AutomationStateStore,
    status: "ok" | "unreadable" | "rate-limited" | "auth-failed",
  ): void {
    store.recordSourceStatus({
      provider: "jira",
      sourceId: "nightly",
      status,
      checkedAt: Date.now(),
      ...(status === "ok" ? {} : { message: `${status} detail` }),
    });
  }

  test("auth failure notifies once while it lasts and resolves on the next ok read", () => {
    const store = new AutomationStateStore(dbPath);
    try {
      record(store, "ok");
      record(store, "auth-failed");
      record(store, "auth-failed");
      const [notification] = open("source_unhealthy");
      expect(notification).toMatchObject({
        severity: "high",
        count: 1,
        title: "jira source nightly: authentication failed",
        body: "auth-failed detail",
      });
      record(store, "ok");
      expect(open("source_unhealthy")).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("unreadable notifies only after consecutive failures; rate limits never do", () => {
    const store = new AutomationStateStore(dbPath);
    try {
      for (let index = 0; index < 5; index += 1) record(store, "rate-limited");
      expect(all("source_unhealthy")).toHaveLength(0);
      record(store, "ok");
      for (let index = 1; index < UNREADABLE_THRESHOLD; index += 1) record(store, "unreadable");
      expect(all("source_unhealthy")).toHaveLength(0);
      record(store, "unreadable");
      record(store, "unreadable");
      expect(open("source_unhealthy")).toHaveLength(1);
      expect(open("source_unhealthy")[0].count).toBe(1);
    } finally {
      store.close();
    }
  });

  test("a direct transition from unhealthy to unhealthy does not re-emit", () => {
    notifySourceHealth(reader, {
      provider: "linear",
      sourceId: "s",
      status: "auth-failed",
      consecutiveFailures: 2,
      previous: { status: "auth-failed", consecutiveFailures: 1 },
    });
    expect(all("source_unhealthy")).toHaveLength(0);
  });
});

describe("emission is best-effort", () => {
  test("a broken notifications table never fails the run finish", () => {
    reader.run("CREATE TABLE notifications (id INTEGER PRIMARY KEY)");
    const runId = runs.createRun({ origin: "task", taskKey: "DEV-99" });
    expect(() => runs.finishRun(runId, "escalated", "blocked")).not.toThrow();
    expect(runs.getRun(runId)?.status).toBe("escalated");
  });
});

describe("helpers", () => {
  test("normalizeCause keeps deny patterns and masks variable parts", () => {
    expect(
      normalizeCause("packages/website/drafts/x.md matches deny pattern packages/website/**"),
    ).toBe("matches deny pattern packages/website/**");
    expect(normalizeCause("CI check build failed 3 times at abc1234")).toBe(
      "ci check build failed <n> times at <sha>",
    );
    expect(normalizeCause("see https://ci.test/run/9 for src/a.ts")).toBe("see <url> for <path>");
    expect(normalizeCause(undefined)).toBe("unknown");
  });

  test("runSubject prefers automation, then task, then PR", () => {
    expect(runSubject({ id: 1, automationId: "a", taskKey: "t" })).toBe("automation:a");
    expect(runSubject({ id: 1, taskKey: "t", prUrl: "u" })).toBe("task:t");
    expect(runSubject({ id: 1, prUrl: "u" })).toBe("pr:u");
    expect(runSubject({ id: 1 })).toBe("run:1");
  });
});
