import { describe, expect, test } from "bun:test";

import {
  createAzureDevOpsChangeDetector,
  createChangeDetector,
  createGitHubChangeDetector,
  createJiraChangeDetector,
  createLinearChangeDetector,
} from "../src/lib/change-detector";

function stubSearch(taskCount: number) {
  const queries: string[] = [];
  const searchTasks = async (query: string) => {
    queries.push(query);
    return { tasks: Array.from({ length: taskCount }, (_, i) => ({ key: `T-${i}` })) };
  };
  return { queries, searchTasks };
}

describe("query-based change detectors", () => {
  test("first run reports changed without calling the tracker", async () => {
    const { queries, searchTasks } = stubSearch(0);
    const detector = createJiraChangeDetector(searchTasks);

    const result = await detector.changesSince(null);
    expect(result.changed).toBe(true);
    expect(queries).toHaveLength(0);
    expect(Number(result.nextCursor)).toBeGreaterThan(0);
  });

  test("a corrupt cursor is treated as a first run", async () => {
    const { queries, searchTasks } = stubSearch(0);
    const detector = createJiraChangeDetector(searchTasks);

    const result = await detector.changesSince("not-a-number");
    expect(result.changed).toBe(true);
    expect(queries).toHaveLength(0);
  });

  test("changed reflects whether the delta query matched anything", async () => {
    const cursor = String(Date.now() - 120_000);

    const empty = createJiraChangeDetector(stubSearch(0).searchTasks);
    expect((await empty.changesSince(cursor)).changed).toBe(false);

    const nonEmpty = createJiraChangeDetector(stubSearch(2).searchTasks);
    expect((await nonEmpty.changesSince(cursor)).changed).toBe(true);
  });

  test("jira uses an overlapping relative JQL window", async () => {
    const { queries, searchTasks } = stubSearch(0);
    const detector = createJiraChangeDetector(searchTasks);

    // Cursor 2 minutes ago → window must be at least 3 minutes (overlap).
    await detector.changesSince(String(Date.now() - 120_000));
    expect(queries[0]).toMatch(/^updated >= "-\d+m"$/);
    const minutes = Number(queries[0]!.match(/-(\d+)m/)![1]);
    expect(minutes).toBeGreaterThanOrEqual(3);
  });

  test("linear uses an updatedAt IssueFilter with the cursor ISO", async () => {
    const { queries, searchTasks } = stubSearch(0);
    const detector = createLinearChangeDetector(searchTasks);

    const since = Date.now() - 60_000;
    await detector.changesSince(String(since));
    const filter = JSON.parse(queries[0]!);
    expect(filter.updatedAt.gt).toBe(new Date(since).toISOString());
  });

  test("github uses the updated:>= search qualifier without milliseconds", async () => {
    const { queries, searchTasks } = stubSearch(0);
    const detector = createGitHubChangeDetector(searchTasks);

    const since = Date.parse("2026-07-03T10:00:00.123Z");
    await detector.changesSince(String(since));
    expect(queries[0]).toBe("updated:>=2026-07-03T10:00:00Z");
  });

  test("azure devops uses a day-precision WIQL window", async () => {
    const { queries, searchTasks } = stubSearch(0);
    const detector = createAzureDevOpsChangeDetector(searchTasks);

    const since = Date.parse("2026-07-03T10:00:00Z");
    await detector.changesSince(String(since));
    expect(queries[0]).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '2026-07-03'",
    );
  });

  test("cursor advances to detection time even when nothing changed", async () => {
    const detector = createLinearChangeDetector(stubSearch(0).searchTasks);
    const oldCursor = String(Date.now() - 300_000);

    const result = await detector.changesSince(oldCursor);
    expect(result.changed).toBe(false);
    expect(Number(result.nextCursor)).toBeGreaterThan(Number(oldCursor));
  });

  test("registry resolves query-based detectors only with searchTasks", () => {
    const { searchTasks } = stubSearch(0);
    expect(createChangeDetector("jira")).toBeNull();
    expect(createChangeDetector("jira", searchTasks)?.source).toBe("jira");
    expect(createChangeDetector("linear", searchTasks)?.source).toBe("linear");
    expect(createChangeDetector("github", searchTasks)?.source).toBe("github");
    expect(createChangeDetector("azure-devops", searchTasks)?.source).toBe("azure-devops");
  });
});
