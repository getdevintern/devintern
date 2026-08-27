import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDocsDriftGuard } from "../src/lib/automations/docs-drift-guard/run";
import type { DocsDriftRunDeps } from "../src/lib/automations/docs-drift-guard/run";
import type { DocsDriftAgentPort } from "../src/lib/automations/docs-drift-guard/agent-port";
import { driftPrMarker, driftTicketMarker } from "../src/lib/automations/docs-drift-guard/ports";
import type {
  DocsDriftPrPort,
  DocsDriftTrackerPort,
} from "../src/lib/automations/docs-drift-guard/ports";
import { AutomationCheckpointStore } from "../src/lib/automations/checkpoint-store";
import { defaultGitPort } from "../src/lib/automations/docs-drift-guard/git-port";
import { computeFindingId } from "../src/lib/automations/docs-drift-guard/result";
import { RunStore } from "../src/lib/run-recorder";
import { createTempRepo } from "./git-fixture";

process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "echo";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "devintern-driftrun-"));
  tempDirs.push(dir);
  return join(dir, "queue.db");
}

const NO_DRIFT = JSON.stringify({ status: "no_drift", findings: [] });
const FINDING = {
  summary: "Login guide misses the new SSO flow",
  affectedBehavior: "Sign-in now requires choosing an SSO provider",
  evidence: [{ file: "src/auth.ts", detail: "adds SSO provider selection" }],
  targetDocuments: ["docs/auth.md"],
  proposedChange: "Document the provider selection step",
  severity: "high",
};
const FINDINGS = JSON.stringify({ status: "findings", findings: [FINDING] });

function fakeAgent(options: { analysis?: string; apply?: (cwd: string) => void }) {
  const calls: Array<{ mode: string; prompt: string }> = [];
  const port: DocsDriftAgentPort = {
    async run(input) {
      calls.push({ mode: input.mode, prompt: input.prompt });
      if (input.mode === "apply") options.apply?.(input.cwd);
      return options.analysis ?? NO_DRIFT;
    },
  };
  return { port, calls };
}

function fakeTracker(options: { existing?: Array<{ key: string }>; failCreate?: boolean }) {
  const created: Array<{ title: string; body: string }> = [];
  const searches: string[] = [];
  const port: DocsDriftTrackerPort = {
    async findOpenWithMarker(marker) {
      searches.push(marker);
      return (options.existing ?? []).map((entry) => ({ key: entry.key }));
    },
    async create(input) {
      if (options.failCreate) throw new Error("tracker unavailable");
      created.push({ title: input.title, body: input.body });
      return {
        key: String(100 + created.length),
        url: `https://tracker.example/issue/${created.length}`,
      };
    },
  };
  return { port, created, searches };
}

function fakePr(options: { existing?: { number: number; headRef: string } | null }) {
  const calls: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const port: DocsDriftPrPort = {
    async findOpenDriftPr({ marker }) {
      calls.push({ op: "find", payload: { marker } });
      return options.existing ?? null;
    },
    async createPullRequest(input) {
      calls.push({ op: "create", payload: { ...input } });
      return { number: 11, url: "https://github.com/acme/api/pull/11" };
    },
    async updatePullRequestBody(input) {
      calls.push({ op: "update", payload: { ...input } });
    },
  };
  return { port, calls };
}

interface World {
  deps: DocsDriftRunDeps;
  dbPath: string;
  agent: ReturnType<typeof fakeAgent>;
  tracker: ReturnType<typeof fakeTracker>;
  pr: ReturnType<typeof fakePr>;
  pushes: Array<{ branch: string; force: boolean }>;
  store: AutomationCheckpointStore;
  runStore: RunStore;
}

/** Repo on main with a committed guide + behavior file; no remote. */
function setupWorld(repo = createTempRepo("drift")): { repo: typeof repo; world: World } {
  repo.write("docs/auth.md", "# Authentication\n\nUse passwords.\n");
  repo.write("README.md", "# Repo\n");
  repo.git(["add", "-A"]);
  repo.git(["commit", "--no-verify", "-m", "docs: initial guides"]);
  const dbPath = makeDb();
  const agent = fakeAgent({ analysis: NO_DRIFT });
  const tracker = fakeTracker({});
  const pr = fakePr({ existing: null });
  const pushes: Array<{ branch: string; force: boolean }> = [];
  const store = new AutomationCheckpointStore(dbPath);
  const runStore = new RunStore(dbPath);
  const git = {
    ...defaultGitPort,
    pushBranch: async (cwd: string, branch: string, force: boolean) => {
      pushes.push({ branch, force });
    },
  };
  return {
    repo,
    world: {
      dbPath,
      agent,
      tracker,
      pr,
      pushes,
      store,
      runStore,
      deps: {
        git,
        agent: agent.port,
        tracker: tracker.port,
        pr: pr.port,
        checkpoints: store,
        runStore,
      },
    },
  };
}

function run(
  repo: ReturnType<typeof createTempRepo>,
  world: World,
  overrides: Partial<Parameters<typeof runDocsDriftGuard>[0]> = {},
) {
  return runDocsDriftGuard(
    {
      automationId: "drift",
      cwd: repo.dir,
      repoName: "repo",
      dbPath: world.dbPath,
      outputMode: "ticket",
      ...overrides,
    },
    world.deps,
  );
}

describe("docs-drift-guard run orchestration", () => {
  afterEach(() => {
    delete process.env.TASK_TRACKER;
  });

  test("first run without baseline establishes the checkpoint without agent work", async () => {
    const { repo, world } = setupWorld();
    const outcome = await run(repo, world);
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toContain("baseline established");
    expect(world.agent.calls).toHaveLength(0);
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(
      repo.git(["rev-parse", "HEAD"]),
    );
    repo.cleanup();
  });

  test("baseline_sha starts analysis at an explicit commit", async () => {
    const { repo, world } = setupWorld();
    const first = repo.git(["rev-parse", "HEAD"]);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    const head = repo.git(["rev-parse", "HEAD"]);
    world.agent.calls.length = 0;
    // The analysis answer now includes the SSO finding.
    world.deps.agent = {
      async run(input) {
        world.agent.calls.push({ mode: input.mode, prompt: input.prompt });
        return FINDINGS;
      },
    } as DocsDriftAgentPort;
    const tracker = fakeTracker({});
    world.deps.tracker = tracker.port;

    const outcome = await run(repo, world, { baselineSha: first.slice(0, 12) });
    expect(outcome.ok).toBe(true);
    expect(world.agent.calls).toHaveLength(1);
    expect(world.agent.calls[0]?.prompt).toContain(`${first.slice(0, 12)}..${head.slice(0, 12)}`);
    expect(tracker.created).toHaveLength(1);
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(head);
    repo.cleanup();
  });

  test("invalid baseline_sha fails safely", async () => {
    const { repo, world } = setupWorld();
    const outcome = await run(repo, world, { baselineSha: "deadbeef" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("baseline_sha");
    repo.cleanup();
  });

  test("no new commits completes without agent work", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    world.agent.calls.length = 0;
    const outcome = await run(repo, world);
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toContain("no new commits");
    expect(world.agent.calls).toHaveLength(0);
    repo.cleanup();
  });

  test("documentation-only merges skip the agent but advance the checkpoint", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.write("docs/auth.md", "# Authentication\n\nUse passwords or SSO.\n");
    repo.commitAll("docs: mention SSO");
    const head = repo.git(["rev-parse", "HEAD"]);
    const outcome = await run(repo, world);
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toContain("no behavior-changing commits");
    expect(world.agent.calls).toHaveLength(0);
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(head);
    repo.cleanup();
  });

  test("a no_drift analysis advances the checkpoint", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.write("src/auth.ts", "export const x = 1;\n");
    repo.commitAll("refactor: internals");
    const head = repo.git(["rev-parse", "HEAD"]);
    const outcome = await run(repo, world);
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toContain("no documentation drift");
    expect(world.agent.calls).toHaveLength(1);
    expect(world.agent.calls[0]?.mode).toBe("analyze");
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(head);
    repo.cleanup();
  });

  test("ticket mode publishes deduplicated tickets and records the run", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    world.deps.agent = {
      async run(input) {
        world.agent.calls.push({ mode: input.mode, prompt: input.prompt });
        return FINDINGS;
      },
    } as DocsDriftAgentPort;

    const outcome = await run(repo, world);
    expect(outcome.ok).toBe(true);
    expect(outcome.created).toEqual([
      {
        kind: "ticket",
        key: "101",
        url: "https://tracker.example/issue/1",
      },
    ]);
    expect(world.tracker.created).toHaveLength(1);
    const body = world.tracker.created[0]?.body ?? "";
    expect(world.tracker.created[0]?.title).toStartWith("[docs-drift]");
    expect(body).toContain(
      driftTicketMarker(
        computeFindingId({
          affectedBehavior: FINDING.affectedBehavior,
          targetDocuments: FINDING.targetDocuments,
        }),
      ),
    );
    expect(body).toContain("src/auth.ts");
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(
      repo.git(["rev-parse", "HEAD"]),
    );

    // Observability: one succeeded run recorded with stage detail.
    const runs = world.runStore.listRuns({});
    const driftRuns = runs.filter((r) => r.taskKey === "docs-drift-guard/repo");
    expect(driftRuns.length).toBeGreaterThanOrEqual(2);
    expect(driftRuns[0]?.status).toBe("succeeded");

    // A later run with an equivalent finding deduplicates instead of
    // creating a second ticket.
    repo.write("src/auth.ts", "export const sso = 'google';\n");
    repo.commitAll("feat: configure SSO provider");
    const dedupe = fakeTracker({ existing: [{ key: "101" }] });
    world.deps.tracker = dedupe.port;
    const second = await run(repo, world);
    expect(second.ok).toBe(true);
    expect(second.deduplicated).toHaveLength(1);
    expect(dedupe.created).toHaveLength(0);
    repo.cleanup();
  });

  test("ticket creation failure preserves the checkpoint for retry", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    world.deps.agent = {
      async run() {
        return FINDINGS;
      },
    } as DocsDriftAgentPort;
    world.deps.tracker = fakeTracker({ failCreate: true }).port;

    const before = world.store.get("repo", "drift")?.lastProcessedSha;
    const outcome = await run(repo, world);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("ticket creation failed");
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(before);
    repo.cleanup();
  });

  test("inconclusive and invalid agent output fail without advancing", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    const before = world.store.get("repo", "drift")?.lastProcessedSha;

    world.deps.agent = {
      async run() {
        return JSON.stringify({ status: "inconclusive", findings: [], notes: "context truncated" });
      },
    } as DocsDriftAgentPort;
    const inconclusive = await run(repo, world);
    expect(inconclusive.ok).toBe(false);
    expect(inconclusive.reason).toContain("inconclusive");

    world.deps.agent = {
      async run() {
        return "looks fine to me";
      },
    } as DocsDriftAgentPort;
    const invalid = await run(repo, world);
    expect(invalid.ok).toBe(false);
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(before);
    repo.cleanup();
  });

  test("PR mode creates a documentation-only pull request and advances", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.git(["remote", "add", "origin", "https://github.com/acme/api.git"]);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    world.deps.agent = {
      async run(input) {
        world.agent.calls.push({ mode: input.mode, prompt: input.prompt });
        if (input.mode === "apply") {
          writeFileSync(join(repo.dir, "docs", "auth.md"), "# Authentication\n\nUse SSO.\n");
        }
        return FINDINGS;
      },
    } as DocsDriftAgentPort;
    world.deps.tracker = null;

    const headBefore = repo.git(["rev-parse", "HEAD"]);
    const outcome = await run(repo, world, { outputMode: "pull_request" });
    expect(outcome.ok).toBe(true);
    const create = world.pr.calls.find((call) => call.op === "create");
    expect(create).toBeDefined();
    expect((create?.payload.head as string)?.startsWith("docs-drift/drift-")).toBe(true);
    expect(create?.payload.base).toBe("main");
    expect(create?.payload.body as string).toContain(driftPrMarker("drift"));
    expect(create?.payload.body as string).toContain(headBefore.slice(0, 12));
    expect(world.pushes).toEqual([{ branch: create?.payload.head as string, force: false }]);
    // The committed tree only contains documentation edits.
    const driftBranch = create?.payload.head as string;
    const committed = repo
      .git(["show", "--name-only", "--pretty=format:", driftBranch])
      .split("\n")
      .filter(Boolean);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.every((path) => path.endsWith(".md"))).toBe(true);
    // The worktree is restored to its original branch.
    expect(repo.git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(headBefore);
    repo.cleanup();
  });

  test("PR mode reuses an existing open drift PR instead of duplicating", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.git(["remote", "add", "origin", "https://github.com/acme/api.git"]);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    world.deps.agent = {
      async run(input) {
        if (input.mode === "apply") {
          writeFileSync(join(repo.dir, "docs", "auth.md"), "# Authentication\n\nUse SSO.\n");
        }
        return FINDINGS;
      },
    } as DocsDriftAgentPort;
    world.deps.tracker = null;
    const reusePr = fakePr({ existing: { number: 7, headRef: "docs-drift/drift-aaaa" } });
    world.deps.pr = reusePr.port;

    const outcome = await run(repo, world, { outputMode: "pull_request" });
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toContain("updated documentation pull request");
    expect(world.pushes).toEqual([{ branch: "docs-drift/drift-aaaa", force: true }]);
    expect(reusePr.calls.some((call) => call.op === "create")).toBe(false);
    expect(reusePr.calls.some((call) => call.op === "update")).toBe(true);
    repo.cleanup();
  });

  test("PR mode refuses non-GitHub remotes before running the agent", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    const outcome = await run(repo, world, { outputMode: "pull_request" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("GitHub origin remote");
    expect(world.agent.calls).toHaveLength(0);
    repo.cleanup();
  });

  test("shallow clones fail safely", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    writeFileSync(join(repo.dir, ".git", "shallow"), "");
    const outcome = await run(repo, world);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("shallow clone");
    expect(world.agent.calls).toHaveLength(0);
    repo.cleanup();
  });

  test("rewritten history fails instead of comparing an incorrect range", async () => {
    const { repo, world } = setupWorld();
    await run(repo, world);
    repo.write("src/auth.ts", "export const sso = true;\n");
    repo.commitAll("feat: add SSO login");
    // Advance the checkpoint to the SSO commit before rewriting history.
    const outcomeAtB = await run(repo, world);
    expect(outcomeAtB.ok).toBe(true);
    const checkpoint = world.store.get("repo", "drift")?.lastProcessedSha;
    // Force-push style rewrite: rebase the tip onto a divergent commit.
    repo.git(["checkout", "--detach", "HEAD~1"]);
    repo.write("src/other.ts", "// divergent\n");
    repo.git(["add", "-A"]);
    repo.git(["commit", "--no-verify", "-m", "feat: divergent history"]);
    repo.git(["checkout", "-B", "main"]);
    const outcome = await run(repo, world);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("no longer an ancestor");
    expect(outcome.reason).toContain("baseline_sha");
    expect(world.store.get("repo", "drift")?.lastProcessedSha).toBe(checkpoint);
    repo.cleanup();
  });
});
