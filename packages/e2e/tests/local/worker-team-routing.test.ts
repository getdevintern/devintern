import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cliPath, MultiRepoWorkerFixture } from "../../helpers/multi-repo-worker";

const BODY = "Change the greeting to Hello, world! and run bun test.";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function taskFile(options: {
  key: string;
  group: string;
  labels?: string[];
  title: string;
}): string {
  return [
    "---",
    `key: ${options.key}`,
    "status: todo",
    `group: ${options.group}`,
    ...(options.labels && options.labels.length > 0
      ? [`labels: ${options.labels.join(", ")}`]
      : []),
    "---",
    "",
    `# ${options.title}`,
    "",
    BODY,
    "",
  ].join("\n");
}

interface ExpectedRun {
  key: string;
  team: string;
  repo: string;
  branch: string;
}

test.skipIf(!existsSync(cliPath))(
  "the multi-repo worker routes per team, records ambiguous/unrouted skips, and layers repo/team env",
  async () => {
    const worker = new MultiRepoWorkerFixture(["repo-a", "repo-b"]);
    try {
      await worker.prepare();

      const repoA = worker.repo("repo-a");
      const repoB = worker.repo("repo-b");
      const repoAFile = join(worker.root, "repo-a-file.jsonl");
      const repoBFile = join(worker.root, "repo-b-file.jsonl");
      const repoBInline = join(worker.root, "repo-b-inline.jsonl");
      const teamAlphaFile = join(worker.root, "team-alpha-file.jsonl");
      const teamBetaFile = join(worker.root, "team-beta-file.jsonl");
      const teamBetaInline = join(worker.root, "team-beta-inline.jsonl");

      worker.writeWorkspaceFile("env/repo-a.env", `E2E_AGENT_INVOCATIONS=${repoAFile}\n`);
      worker.writeWorkspaceFile("env/repo-b.env", `E2E_AGENT_INVOCATIONS=${repoBFile}\n`);
      worker.writeWorkspaceFile("env/team-alpha.env", `E2E_AGENT_INVOCATIONS=${teamAlphaFile}\n`);
      worker.writeWorkspaceFile("env/team-beta.env", `E2E_AGENT_INVOCATIONS=${teamBetaFile}\n`);
      worker.writeWorkspaceFile(
        ".env",
        [`MARKDOWN_TASKS_DIR=${worker.tasksDir}`, "TASK_TRACKER=markdown", ""].join("\n"),
      );
      worker.writeWorkspaceFile(
        "workspace.toml",
        [
          "[workspace]",
          "dashboard = false",
          "",
          "[workspace.execution]",
          'isolation = "best_effort_host"',
          "max_concurrency = 1",
          "max_concurrency_per_repo = 1",
          "",
          "[defaults]",
          'tracker = "markdown"',
          'worker_task_args = "--create-pr --skip-clarity-check --skip-comments"',
          "poll_interval = 1",
          "",
          "[[repos]]",
          `name = ${tomlString(repoA.name)}`,
          `remote = ${tomlString(repoA.remote)}`,
          `default_branch = ${tomlString(worker.baseBranch)}`,
          'env_file = "env/repo-a.env"',
          "",
          "[[repos]]",
          `name = ${tomlString(repoB.name)}`,
          `remote = ${tomlString(repoB.remote)}`,
          `default_branch = ${tomlString(worker.baseBranch)}`,
          'env_file = "env/repo-b.env"',
          "  [repos.env]",
          `  E2E_AGENT_INVOCATIONS = ${tomlString(repoBInline)}`,
          "",
          "[[teams]]",
          'name = "alpha"',
          'tracker = "markdown"',
          'task_query = "status=todo group=alpha"',
          'env_file = "env/team-alpha.env"',
          "",
          "[[teams]]",
          'name = "beta"',
          'tracker = "markdown"',
          'task_query = "status=todo group=beta"',
          'env_file = "env/team-beta.env"',
          "  [teams.env]",
          `  E2E_AGENT_INVOCATIONS = ${tomlString(teamBetaInline)}`,
          "",
          "[[teams]]",
          'name = "gamma"',
          'tracker = "markdown"',
          'task_query = "status=todo group=gamma"',
          "",
          "[[teams]]",
          'name = "delta"',
          'tracker = "markdown"',
          'task_query = "status=todo group=delta"',
          "",
          "[[routing.rules]]",
          'team = "alpha"',
          'repo = "repo-a"',
          'labels = ["area: alpha"]',
          "",
          "[[routing.rules]]",
          'team = "alpha"',
          'repo = "repo-b"',
          'labels = ["area: ambiguous"]',
          "",
          "[[routing.rules]]",
          'team = "beta"',
          'repo = "repo-b"',
          'labels = ["area: beta"]',
          "",
          "[[routing.rules]]",
          'team = "gamma"',
          'repo = "repo-a"',
          'labels = ["area: gamma"]',
          "",
          "[[routing.rules]]",
          'team = "delta"',
          'repo = "repo-b"',
          'labels = ["area: delta"]',
          "",
        ].join("\n"),
      );

      const heartbeat = worker.writeTask(
        "heartbeat.md",
        taskFile({ key: "heartbeat", group: "heartbeat", title: "Polling heartbeat" }),
      );
      worker.writeTask(
        "alpha-a.md",
        taskFile({
          key: "alpha-a",
          group: "alpha",
          labels: ["area: alpha"],
          title: "Alpha task for repo A",
        }),
      );
      worker.writeTask(
        "alpha-ambiguous.md",
        taskFile({
          key: "alpha-ambiguous",
          group: "alpha",
          labels: ["area: alpha", "area: ambiguous"],
          title: "Alpha task matching two repos",
        }),
      );
      worker.writeTask(
        "beta-b.md",
        taskFile({
          key: "beta-b",
          group: "beta",
          labels: ["area: beta"],
          title: "Beta task for repo B",
        }),
      );
      worker.writeTask(
        "gamma-env.md",
        taskFile({
          key: "gamma-env",
          group: "gamma",
          labels: ["area: gamma"],
          title: "Gamma task using repo env",
        }),
      );
      worker.writeTask(
        "gamma-unrouted.md",
        taskFile({
          key: "gamma-unrouted",
          group: "gamma",
          labels: ["area: beta"],
          title: "Gamma task without a visible rule",
        }),
      );
      worker.writeTask(
        "delta-b.md",
        taskFile({
          key: "delta-b",
          group: "delta",
          labels: ["area: delta"],
          title: "Delta task using inline repo env",
        }),
      );

      worker.start();
      await worker.waitForReady();

      const expectedRuns: ExpectedRun[] = [
        { key: "alpha-a", team: "alpha", repo: "repo-a", branch: "feature/alpha-a" },
        { key: "beta-b", team: "beta", repo: "repo-b", branch: "feature/beta-b" },
        { key: "gamma-env", team: "gamma", repo: "repo-a", branch: "feature/gamma-env" },
        { key: "delta-b", team: "delta", repo: "repo-b", branch: "feature/delta-b" },
      ];
      const diagnostics = () =>
        [
          `runs: ${JSON.stringify(worker.runRecords(), null, 2)}`,
          `routing skips: ${JSON.stringify(worker.routingSkips(), null, 2)}`,
          `alpha file: ${JSON.stringify(worker.agentInvocations(teamAlphaFile))}`,
          `repo A file: ${JSON.stringify(worker.agentInvocations(repoAFile))}`,
          `repo B file: ${JSON.stringify(worker.agentInvocations(repoBFile))}`,
          `repo B inline: ${JSON.stringify(worker.agentInvocations(repoBInline))}`,
          `team beta file: ${JSON.stringify(worker.agentInvocations(teamBetaFile))}`,
          `team beta inline: ${JSON.stringify(worker.agentInvocations(teamBetaInline))}`,
          `global: ${JSON.stringify(worker.agentInvocations(worker.globalInvocations))}`,
          worker.tail(),
        ].join("\n");

      const runs = await worker.waitFor(
        "all routed tasks to succeed",
        () => {
          const current = worker.runRecords();
          const complete = expectedRuns.every((expected) =>
            current.some(
              (run) =>
                run.task_key === expected.key &&
                run.status === "succeeded" &&
                run.team === expected.team &&
                run.repo === expected.repo &&
                run.branch === expected.branch,
            ),
          );
          return complete ? current : undefined;
        },
        120_000,
      );

      const skips = await worker.waitFor(
        "ambiguous and unrouted routing skips",
        () => {
          const current = worker.routingSkips();
          const ambiguous = current.some(
            (skip) => skip.task_key === "alpha-ambiguous" && skip.reason === "ambiguous",
          );
          const unrouted = current.some(
            (skip) => skip.task_key === "gamma-unrouted" && skip.reason === "unrouted",
          );
          return ambiguous && unrouted ? current : undefined;
        },
        30_000,
      );

      // A later detector cycle must see the already-processed tasks and skip
      // them again without recording another skip or starting another run.
      const since = worker.outputLength;
      worker.touch(heartbeat);
      await worker.waitForOutputSince(
        /skipping [^\n]*alpha-ambiguous[^\n]*already processed/,
        since,
        30_000,
        "ambiguous task deduplicated on a later poll",
      );
      await worker.waitForOutputSince(
        /skipping [^\n]*gamma-unrouted[^\n]*already processed/,
        since,
        30_000,
        "unrouted task deduplicated on a later poll",
      );

      const finalRuns = worker.runRecords();
      const finalSkips = worker.routingSkips();
      expect(finalRuns, diagnostics()).toHaveLength(expectedRuns.length);
      expect(finalSkips, diagnostics()).toHaveLength(2);
      expect(runs, diagnostics()).toHaveLength(expectedRuns.length);
      expect(skips, diagnostics()).toHaveLength(2);

      for (const expected of expectedRuns) {
        const run = finalRuns.find((candidate) => candidate.task_key === expected.key);
        expect(run, diagnostics()).toMatchObject({
          task_key: expected.key,
          status: "succeeded",
          team: expected.team,
          repo: expected.repo,
          branch: expected.branch,
        });
      }

      const ambiguous = finalSkips.find((skip) => skip.task_key === "alpha-ambiguous");
      expect(ambiguous, diagnostics()).toMatchObject({
        reason: "ambiguous",
        candidates: ["repo-a", "repo-b"],
        team: "alpha",
      });
      const unrouted = finalSkips.find((skip) => skip.task_key === "gamma-unrouted");
      expect(unrouted, diagnostics()).toMatchObject({
        reason: "unrouted",
        candidates: [],
        team: "gamma",
      });
      expect(
        finalRuns.filter(
          (run) => run.task_key === "alpha-ambiguous" || run.task_key === "gamma-unrouted",
        ),
        diagnostics(),
      ).toEqual([]);

      const repoABranches = (await worker.repoBranches("repo-a")).sort();
      const repoBBranches = (await worker.repoBranches("repo-b")).sort();
      expect(repoABranches, diagnostics()).toEqual(
        [worker.baseBranch, "feature/alpha-a", "feature/gamma-env"].sort(),
      );
      expect(repoBBranches, diagnostics()).toEqual(
        [worker.baseBranch, "feature/beta-b", "feature/delta-b"].sort(),
      );

      for (const expected of expectedRuns) {
        expect(
          await worker.branchChangedFiles(expected.repo, expected.branch),
          diagnostics(),
        ).toEqual(["src/greeting.ts"]);
        expect(
          await worker.repoBranchFile(expected.repo, expected.branch, "src/greeting.ts"),
          diagnostics(),
        ).toBe('export const greeting = "Hello, world!";');
      }

      // Each successful task must observe exactly the winning credential layer:
      // repo env_file for gamma, repo inline for delta, team env_file for alpha,
      // and team inline for beta. Skipped tasks must reach no agent at all.
      expect(worker.agentInvocations(repoAFile), diagnostics()).toEqual([{ mode: "implement" }]);
      expect(worker.agentInvocations(teamAlphaFile), diagnostics()).toEqual([
        { mode: "implement" },
      ]);
      expect(worker.agentInvocations(repoBFile), diagnostics()).toEqual([]);
      expect(worker.agentInvocations(repoBInline), diagnostics()).toEqual([{ mode: "implement" }]);
      expect(worker.agentInvocations(teamBetaFile), diagnostics()).toEqual([]);
      expect(worker.agentInvocations(teamBetaInline), diagnostics()).toEqual([
        { mode: "implement" },
      ]);
      expect(worker.agentInvocations(worker.globalInvocations), diagnostics()).toEqual([]);

      expect(worker.running, diagnostics()).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  // Worst case inside the body: 30s readiness + 120s routed runs + 30s skips
  // + 30s + 30s dedupe polls + 25s SIGTERM + 5s SIGKILL + 5s descendant
  // SIGTERM + 2s descendant SIGKILL = 277s, plus prepare() (two seed cycles)
  // and the per-branch git assertions. Leave headroom above that sum.
  330_000,
);
