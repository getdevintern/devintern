import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { DependencyFacts } from "../src/lib/dependencies/gate";
import { STACK_NOTICE_MARKER, StackMaintainer } from "../src/lib/dependencies/stack-maintainer";
import type {
  RestackResult,
  StackGit,
  StackHost,
  StackLink,
  StackPrSnapshot,
  StackStore,
} from "../src/lib/dependencies/stack-maintainer";
import { InjectedTaskStore } from "../src/lib/state/injected-tasks";
import { RunStore } from "../src/lib/state/run-recorder";
import type { WorkspaceConfig } from "../src/lib/workspace/config";
import { createPrBusyChecker, parseStackPr } from "../src/lib/workspace/stacked-pr-acquirer";

/** In-memory {@link StackStore}: links plus the facts each task key reads as. */
class FakeStore implements StackStore {
  links: StackLink[] = [];
  facts = new Map<string, DependencyFacts>();
  stackedOn: Array<[number, string | null]> = [];

  listStackedLinks(): StackLink[] {
    return this.links.filter((link) => link.stackedOn !== "");
  }
  dependencyFacts(keys: readonly string[]): DependencyFacts[] {
    return keys.map((key) => this.facts.get(key) ?? { key, work: "missing" });
  }
  setStackedOn(id: number, key: string | null): void {
    this.stackedOn.push([id, key]);
    const link = this.links.find((candidate) => candidate.id === id);
    if (link) link.stackedOn = key ?? "";
  }
  setStackBaseSha(id: number, sha: string | null): void {
    const link = this.links.find((candidate) => candidate.id === id);
    if (link) link.baseHeadSha = sha ?? undefined;
  }
  setStackNotice(id: number, notice: string | null): void {
    const link = this.links.find((candidate) => candidate.id === id);
    if (link) link.notice = notice ?? undefined;
  }

  task(key: string, prNumber: number): void {
    this.facts.set(key, {
      key,
      work: "done",
      latestRun: { status: "succeeded", prNumber, branch: `feature/${key}` },
      pr: { number: prNumber, branch: `feature/${key}`, state: "open" },
    });
  }
}

class FakeHost implements StackHost {
  prs = new Map<number, StackPrSnapshot>();
  retargets: Array<[number, string]> = [];
  notices: Array<[number, string]> = [];

  async getPr(_repo: string, prNumber: number): Promise<StackPrSnapshot | null> {
    const pr = this.prs.get(prNumber);
    return pr ? { ...pr } : null;
  }
  async retarget(_repo: string, prNumber: number, base: string): Promise<void> {
    this.retargets.push([prNumber, base]);
    const pr = this.prs.get(prNumber);
    if (pr) pr.baseRef = base;
  }
  async postNotice(_repo: string, prNumber: number, body: string): Promise<void> {
    this.notices.push([prNumber, body]);
  }

  pr(number: number, fields: Partial<StackPrSnapshot> & { headRef: string }): void {
    this.prs.set(number, {
      number,
      state: "open",
      headSha: `${fields.headRef}-head`,
      baseRef: "main",
      ...fields,
    });
  }
}

class FakeGit implements StackGit {
  calls: Array<Parameters<StackGit["restack"]>[0]> = [];
  results: RestackResult[] = [];
  async restack(input: Parameters<StackGit["restack"]>[0]): Promise<RestackResult> {
    this.calls.push(input);
    return (
      this.results.shift() ?? {
        kind: "restacked",
        headSha: `${input.branch}-restacked`,
        baseSha: `${input.onto}-tip`,
      }
    );
  }
}

describe("stacked PR maintainer", () => {
  let store: FakeStore;
  let host: FakeHost;
  let gitOps: FakeGit;
  let maintainer: StackMaintainer;
  let busy: Set<number>;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    store = new FakeStore();
    host = new FakeHost();
    gitOps = new FakeGit();
    busy = new Set();
    maintainer = new StackMaintainer({
      store,
      host,
      git: gitOps,
      isPrBusy: (_repo, prNumber) => busy.has(prNumber),
      log: () => {},
      warn: (message) => warnings.push(message),
    });
    // A (PR #15 → main) ← B (PR #16 → feature/local-a).
    store.task("local-a", 15);
    store.task("local-b", 16);
    store.links.push({
      id: 2,
      taskKey: "local-b",
      repo: "backend",
      stackedOn: "local-a",
      baseHeadSha: "a-tip",
    });
    host.pr(15, { headRef: "feature/local-a", headSha: "a-tip" });
    host.pr(16, { headRef: "feature/local-b", baseRef: "feature/local-a" });
  });

  test("base merged, host did not retarget: retargets, restacks, and unstacks", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-merged-head", state: "merged" });

    const outcomes = await maintainer.tick();

    expect(outcomes.get("local-b")).toBe("retargeted");
    expect(host.retargets).toEqual([[16, "main"]]);
    expect(gitOps.calls).toEqual([
      {
        repo: "backend",
        branch: "feature/local-b",
        expectedHeadSha: "feature/local-b-head",
        onto: "main",
        oldBaseCandidates: ["a-merged-head", "a-tip"],
      },
    ]);
    expect(store.stackedOn).toEqual([[2, null]]);
    // Nothing left to maintain.
    expect((await maintainer.tick()).size).toBe(0);
  });

  test("base merged, host already retargeted: restacks without retargeting", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-merged-head", state: "merged" });
    host.pr(16, { headRef: "feature/local-b", baseRef: "main" });

    expect((await maintainer.tick()).get("local-b")).toBe("retargeted");
    expect(host.retargets).toEqual([]);
    expect(gitOps.calls.map((call) => call.onto)).toEqual(["main"]);
    expect(store.stackedOn).toEqual([[2, null]]);
  });

  test("restack conflict after the merge falls back to base sync", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-merged-head", state: "merged" });
    gitOps.results = [{ kind: "conflict", detail: "CONFLICT (content): b.txt" }];

    expect((await maintainer.tick()).get("local-b")).toBe("conflict");
    // Still retargeted, so the host reports the PR conflicting with main and
    // the review poller's base sync resolves it; the link is handed off.
    expect(host.retargets).toEqual([[16, "main"]]);
    expect(store.stackedOn).toEqual([[2, null]]);
  });

  test("a stale restack after the merge keeps the link for the next pass", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-merged-head", state: "merged" });
    gitOps.results = [{ kind: "stale", detail: "moved" }];

    expect((await maintainer.tick()).get("local-b")).toBe("stale");
    expect(store.stackedOn).toEqual([]);
    // Next pass: already retargeted, restack again.
    expect((await maintainer.tick()).get("local-b")).toBe("retargeted");
    expect(host.retargets).toEqual([[16, "main"]]);
    expect(gitOps.calls).toHaveLength(2);
  });

  test("open base with new commits: restacks onto its new head, once", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-fixed" });

    expect((await maintainer.tick()).get("local-b")).toBe("restacked");
    expect(gitOps.calls).toEqual([
      {
        repo: "backend",
        branch: "feature/local-b",
        expectedHeadSha: "feature/local-b-head",
        onto: "feature/local-a",
        oldBaseCandidates: ["a-tip"],
      },
    ]);
    expect(store.links[0]?.baseHeadSha).toBe("feature/local-a-tip");
    expect(host.retargets).toEqual([]);
  });

  test("open base unchanged: no git work", async () => {
    expect((await maintainer.tick()).get("local-b")).toBe("unchanged");
    expect(gitOps.calls).toEqual([]);
  });

  test("an open-base conflict is not retried for the same heads", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-fixed" });
    gitOps.results = [{ kind: "conflict", detail: "CONFLICT" }];

    expect((await maintainer.tick()).get("local-b")).toBe("conflict");
    expect((await maintainer.tick()).get("local-b")).toBe("conflict");
    expect(gitOps.calls).toHaveLength(1);
  });

  test("an open-base push the remote rejects is warned once and not retried", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-fixed" });
    gitOps.results = [
      { kind: "push-rejected", detail: "[remote rejected] (pre-receive hook declined)" },
    ];

    expect((await maintainer.tick()).get("local-b")).toBe("rejected");
    expect((await maintainer.tick()).get("local-b")).toBe("rejected");
    expect(gitOps.calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("remote rejected the restack push");

    // The base moves again: a new attempt.
    host.pr(15, { headRef: "feature/local-a", headSha: "a-fixed-2" });
    store.links[0]!.baseHeadSha = "a-fixed";
    expect((await maintainer.tick()).get("local-b")).toBe("restacked");
    expect(gitOps.calls).toHaveLength(2);
  });

  test("a rejected push after the merge warns and hands the link off", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-merged-head", state: "merged" });
    gitOps.results = [{ kind: "push-rejected", detail: "[remote rejected]" }];

    expect((await maintainer.tick()).get("local-b")).toBe("rejected");
    expect(host.retargets).toEqual([[16, "main"]]);
    expect(store.stackedOn).toEqual([[2, null]]);
    expect(warnings).toHaveLength(1);
    expect((await maintainer.tick()).size).toBe(0);
  });

  test("chain A → B → C: C restacks onto B's new head in the same pass", async () => {
    store.task("local-c", 17);
    store.links.push({
      id: 3,
      taskKey: "local-c",
      repo: "backend",
      stackedOn: "local-b",
      baseHeadSha: "feature/local-b-head",
    });
    host.pr(17, { headRef: "feature/local-c", baseRef: "feature/local-b" });
    // A got a review fix.
    host.pr(15, { headRef: "feature/local-a", headSha: "a-fixed" });

    const outcomes = await maintainer.tick();

    expect(outcomes.get("local-b")).toBe("restacked");
    expect(outcomes.get("local-c")).toBe("restacked");
    expect(gitOps.calls.map((call) => [call.branch, call.onto, call.oldBaseCandidates])).toEqual([
      ["feature/local-b", "feature/local-a", ["a-tip"]],
      // B's old head is stripped; B is not retargeted, and neither is C.
      ["feature/local-c", "feature/local-b", ["feature/local-b-head"]],
    ]);
    expect(host.retargets).toEqual([]);
  });

  test("chain A → B → C after A merges: B moves to main, C stays on B", async () => {
    store.task("local-c", 17);
    store.links.push({
      id: 3,
      taskKey: "local-c",
      repo: "backend",
      stackedOn: "local-b",
      baseHeadSha: "feature/local-b-head",
    });
    host.pr(17, { headRef: "feature/local-c", baseRef: "feature/local-b" });
    host.pr(15, { headRef: "feature/local-a", headSha: "a-tip", state: "merged" });

    await maintainer.tick();

    expect(host.retargets).toEqual([[16, "main"]]);
    expect(gitOps.calls.map((call) => [call.branch, call.onto])).toEqual([
      ["feature/local-b", "main"],
      ["feature/local-c", "feature/local-b"],
    ]);
    expect(store.stackedOn).toEqual([[2, null]]);
  });

  test("base closed without merging: one comment, run untouched, never retargeted", async () => {
    host.pr(15, {
      headRef: "feature/local-a",
      headSha: "a-tip",
      state: "closed",
      url: "https://github.com/acme/backend/pull/15",
    });

    expect((await maintainer.tick()).get("local-b")).toBe("notified");
    expect((await maintainer.tick()).get("local-b")).toBe("unchanged");

    expect(host.notices).toHaveLength(1);
    const [number, body] = host.notices[0] ?? [];
    expect(number).toBe(16);
    expect(body?.startsWith(STACK_NOTICE_MARKER)).toBe(true);
    expect(body).toContain("local-a ([PR #15](https://github.com/acme/backend/pull/15))");
    expect(store.links[0]?.notice).toBe("blocked: local-a PR #15 closed without merging");
    // The stacked task's own run still reads succeeded (no escalation).
    expect(store.facts.get("local-b")?.latestRun?.status).toBe("succeeded");
    expect(host.retargets).toEqual([]);
    expect(gitOps.calls).toEqual([]);
  });

  test("closed → notified → reopened and merged → notice cleared, retargeted", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-tip", state: "closed" });
    expect((await maintainer.tick()).get("local-b")).toBe("notified");

    // The operator reopens and merges the base.
    host.pr(15, { headRef: "feature/local-a", headSha: "a-merged-head", state: "merged" });
    expect((await maintainer.tick()).get("local-b")).toBe("retargeted");

    expect(store.links[0]?.notice).toBeUndefined();
    expect(host.retargets).toEqual([[16, "main"]]);
    expect(host.notices).toHaveLength(2);
    expect(host.notices[1]?.[1]).toContain("local-a PR #15 is merged");
    expect(gitOps.calls.map((call) => [call.branch, call.onto])).toEqual([
      ["feature/local-b", "main"],
    ]);
  });

  test("closed base, PR retargeted by hand: block cleared, then left alone", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-tip", state: "closed" });
    expect((await maintainer.tick()).get("local-b")).toBe("notified");

    host.pr(16, { headRef: "feature/local-b", baseRef: "main" });
    expect((await maintainer.tick()).get("local-b")).toBe("unblocked");
    expect(store.links[0]?.notice).toBeUndefined();
    expect(host.notices[1]?.[1]).toContain("now targets main");

    // Not re-notified on later passes, and never restacked or retargeted.
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");
    expect(host.notices).toHaveLength(2);
    expect(host.retargets).toEqual([]);
    expect(gitOps.calls).toEqual([]);
  });

  test("closed base, stacked PR then merged or closed: block cleared, stack kept", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-tip", state: "closed" });
    expect((await maintainer.tick()).get("local-b")).toBe("notified");

    host.pr(16, { headRef: "feature/local-b", baseRef: "feature/local-a", state: "closed" });
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");
    expect(store.links[0]?.notice).toBeUndefined();

    // Notified again after a reopen: closed PRs are not cached.
    host.pr(16, { headRef: "feature/local-b", baseRef: "feature/local-a" });
    expect((await maintainer.tick()).get("local-b")).toBe("notified");

    // The registry learns the merge: cleared without asking the host.
    const b = store.facts.get("local-b");
    if (b?.pr) b.pr.state = "merged";
    host.prs.delete(16);
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");
    expect(store.links[0]?.notice).toBeUndefined();
    // stacked_on stays: the gate needs it to judge where the merge landed.
    expect(store.stackedOn).toEqual([]);
  });

  test("a reopened stacked PR is maintained again; a merged one is never re-fetched", async () => {
    host.pr(16, { headRef: "feature/local-b", baseRef: "feature/local-a", state: "closed" });
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");

    host.pr(15, { headRef: "feature/local-a", headSha: "a-fix" });
    host.pr(16, { headRef: "feature/local-b", baseRef: "feature/local-a" });
    expect((await maintainer.tick()).get("local-b")).toBe("restacked");

    host.pr(16, { headRef: "feature/local-b", baseRef: "feature/local-a", state: "merged" });
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");
    let fetched = 0;
    const getPr = host.getPr.bind(host);
    host.getPr = async (repo, number) => {
      if (number === 16) fetched += 1;
      return getPr(repo, number);
    };
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");
    expect(fetched).toBe(0);
  });

  test("a PR with an agent run in progress is not restacked until it finishes", async () => {
    host.pr(15, { headRef: "feature/local-a", headSha: "a-fix" });
    busy.add(16);
    expect((await maintainer.tick()).get("local-b")).toBe("busy");
    expect(gitOps.calls).toEqual([]);

    busy.clear();
    expect((await maintainer.tick()).get("local-b")).toBe("restacked");
    expect(gitOps.calls).toHaveLength(1);
  });

  test("skips a stacked PR that is closed, retargeted elsewhere, or unsupported", async () => {
    host.pr(16, { headRef: "feature/local-b", baseRef: "release/1.0" });
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");

    host.prs.delete(16);
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");

    host.pr(16, { headRef: "feature/local-b", baseRef: "feature/local-a", state: "merged" });
    expect((await maintainer.tick()).get("local-b")).toBe("skipped");
    expect(gitOps.calls).toEqual([]);
  });
});

describe("stacked links in the injected-task store", () => {
  let dir: string;
  let store: InjectedTaskStore;
  let raw: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stacked-links-"));
    store = new InjectedTaskStore(join(dir, "queue.db"));
    store.hasPending();
    raw = new Database(join(dir, "queue.db"));
  });
  afterEach(() => {
    raw.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insert(key: string, stackedOn: string | null, finishedAt: number): number {
    const task = store.enqueue({
      taskKey: key,
      repo: "backend",
      title: key,
      body: "",
      taskFile: join(dir, `${key}.md`),
    }).task;
    raw.run(
      "UPDATE injected_tasks SET status = 'done', stacked_on = ?, finished_at = ? WHERE id = ?",
      [stackedOn, finishedAt, task.id],
    );
    return task.id;
  }

  test("lists settled stacked rows with each base before its dependents", () => {
    insert("local-a", null, 1);
    // C finished before B, but B is C's base.
    const c = insert("local-c", "local-b", 2);
    const b = insert("local-b", "local-a", 3);

    expect(store.listStackedLinks().map((link) => link.taskKey)).toEqual(["local-b", "local-c"]);

    store.setStackBaseSha(c, "abc123");
    store.setStackNotice(b, "blocked: local-a PR #15 closed without merging");
    const links = store.listStackedLinks();
    expect(links.find((link) => link.id === c)?.baseHeadSha).toBe("abc123");
    expect(links.find((link) => link.id === b)?.notice).toContain("closed without merging");

    store.setStackedOn(b, null);
    expect(store.listStackedLinks().map((link) => link.taskKey)).toEqual(["local-c"]);
  });
});

describe("PR busy check (fleet)", () => {
  let dir: string;
  let runs: RunStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stacked-busy-"));
    runs = new RunStore(join(dir, "queue.db"));
  });
  afterEach(() => {
    runs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an in-progress follow-up run on the PR or its branch makes it busy", () => {
    const config = {
      repos: [{ name: "backend", env: {}, remote: "git@github.com:acme/backend.git" }],
    } as unknown as WorkspaceConfig;
    const busy = createPrBusyChecker(config, runs);
    expect(busy("backend", 16, "feature/local-b")).toBe(false);

    // Review follow-ups record the slug, PR number and branch but no task key.
    const review = runs.createRun({
      origin: "pr_mention",
      repo: "acme/backend",
      prNumber: 16,
      branch: "feature/local-b",
    });
    expect(busy("backend", 16, "feature/local-b")).toBe(true);
    expect(busy("backend", 17, "feature/local-c")).toBe(false);
    runs.finishRun(review, "succeeded");
    expect(busy("backend", 16, "feature/local-b")).toBe(false);

    // Base sync matched on branch alone; a run with no repo never matches.
    runs.createRun({
      origin: "conflict_resolution",
      repo: "Acme/Backend",
      branch: "feature/local-b",
    });
    runs.createRun({ origin: "local", prNumber: 17 });
    expect(busy("backend", 99, "feature/local-b")).toBe(true);
    expect(busy("backend", 17, "feature/local-c")).toBe(false);
  });
});

describe("GitHub PR payload for stacked maintenance", () => {
  const pr = {
    head: { ref: "feature/local-b", sha: "b".repeat(40) },
    base: { ref: "feature/local-a" },
    html_url: "https://github.com/acme/backend/pull/16",
  };

  test("reads open, merged, and closed-unmerged PRs", () => {
    expect(parseStackPr(16, { ...pr, state: "open" })).toEqual({
      number: 16,
      state: "open",
      headRef: "feature/local-b",
      headSha: "b".repeat(40),
      baseRef: "feature/local-a",
      url: "https://github.com/acme/backend/pull/16",
    });
    expect(parseStackPr(16, { ...pr, state: "closed", merged: true })?.state).toBe("merged");
    expect(
      parseStackPr(16, { ...pr, state: "closed", merged_at: "2026-11-18T08:00:00Z" })?.state,
    ).toBe("merged");
    expect(parseStackPr(16, { ...pr, state: "closed", merged: false })?.state).toBe("closed");
  });

  test("an unusable payload reads as unknown", () => {
    expect(parseStackPr(16, { ...pr, state: "closed" })).toBeNull();
    expect(parseStackPr(16, { ...pr, state: null })).toBeNull();
    expect(parseStackPr(16, { state: "open", base: { ref: "main" } })).toBeNull();
  });
});
