import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MultiRepoWorkerFixture } from "../../helpers/multi-repo-worker";
import { readStepMarkers, writeMarkerPlugin, writePipelineFile } from "../../helpers/pipeline-file";
import type { PipelineStepMarker } from "../../helpers/pipeline-file";
import { checkedCommand } from "../../helpers/process";
import { cliPath, WorkerFixture } from "../../helpers/worker";
import type { WorkerInjectedTask, WorkerRunRecord } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

const CANONICAL_GREETING = 'export const greeting = "Hello, world!";';
const BODY = "Change the greeting to Hello, world! and run bun test.";
// Alphanumeric so tracker-style Markdown escaping can never hide them.
const HALT_MARKER = "E2EPIPELINEHALT";
const WARN_MARKER = "E2EPIPELINEWARN";

/** Branch refs in one local bare remote (`git ls-remote --heads`). */
async function remoteRefs(worker: WorkerFixture, remote: string): Promise<string[]> {
  const output = await checkedCommand(
    ["git", "ls-remote", "--heads", remote],
    worker.root,
    worker.env,
  );
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref): ref is string => Boolean(ref));
}

/**
 * Worker log lines for one injected task.
 *
 * Each fixture runs one task at a time (`max_concurrency = 1`), so a task's
 * output sits between its own `running <key>` line and the next one.
 */
function taskLog(worker: WorkerFixture, taskKey: string): string {
  const logs = worker.logs;
  const start = logs.indexOf(`[local:add] running ${taskKey} `);
  if (start === -1) return "";
  const next = logs.indexOf("[local:add] running ", start + 1);
  return next === -1 ? logs.slice(start) : logs.slice(start, next);
}

function diagnostics(worker: WorkerFixture, details: unknown[] = []): string {
  return [
    ...details.map((detail) => (typeof detail === "string" ? detail : JSON.stringify(detail))),
    `agent invocations: ${JSON.stringify(worker.agentInvocations())}`,
    worker.tail(),
  ].join("\n");
}

async function settle(
  worker: WorkerFixture,
  task: WorkerInjectedTask,
): Promise<{ task: WorkerInjectedTask; run: WorkerRunRecord }> {
  const { task: settled, runs } = await worker.waitForSettled(task.id, 60_000);
  expect(runs, diagnostics(worker, [settled])).toHaveLength(1);
  return { task: settled, run: runs[0]! };
}

function markersFor(markers: PipelineStepMarker[], taskKey: string): PipelineStepMarker[] {
  return markers.filter((marker) => marker.taskKey === taskKey);
}

cliTest(
  "a workspace pipeline_file plugin step runs between commit and finalize; halt stops delivery, warn continues",
  async () => {
    const pipeline = 'pipeline_file = "pipelines/gate.json"';
    const worker = new WorkerFixture({
      repos: ["gated", "strict"],
      repoTomlExtra: {
        gated: pipeline,
        // Same pipeline, but unfinished-work preservation is off, so a halted
        // run must leave nothing at all on the remote.
        strict: [pipeline, "[repos.env]", 'DEVINTERN_PUSH_UNFINISHED_WORK = "0"'].join("\n"),
      },
    });
    const markerDir = join(worker.root, "markers");
    try {
      await worker.prepare();
      const pipelinesDir = join(worker.workspaceDir, "pipelines");
      writeMarkerPlugin(pipelinesDir, "gate");
      const gateOptions = {
        markerDir,
        haltMarker: HALT_MARKER,
        warnMarker: WARN_MARKER,
        reason: "policy gate blocked delivery",
        threshold: 3,
      };
      const gatePath = writePipelineFile(pipelinesDir, "gate.json", {
        plugins: ["./steps/gate.ts"],
        steps: [
          { use: "implement" },
          { use: "commit" },
          { use: "gate", ...gateOptions },
          { use: "finalize" },
        ],
      });

      const strictHalt = await worker.addTask({
        repo: "strict",
        title: "Pipeline halt strict",
        body: `${BODY}\n\n${HALT_MARKER}`,
      });
      const gatedHalt = await worker.addTask({
        repo: "gated",
        title: "Pipeline halt preserved",
        body: `${BODY}\n\n${HALT_MARKER}`,
      });
      const gatedWarn = await worker.addTask({
        repo: "gated",
        title: "Pipeline warn",
        body: `${BODY}\n\n${WARN_MARKER}`,
      });
      worker.start();
      await worker.waitForReady();

      const strict = await settle(worker, strictHalt);
      const preserved = await settle(worker, gatedHalt);
      const warned = await settle(worker, gatedWarn);
      const markers = readStepMarkers(markerDir);
      const details = diagnostics(worker, [strict, preserved, warned, markers]);

      // The plugin loaded from the workspace and ran once per task, after
      // `commit`, with the step entry (minus `use`) as its create(config).
      for (const task of [strict, preserved, warned]) {
        const ran = markersFor(markers, task.task.task_key);
        expect(ran, details).toHaveLength(1);
        expect(ran[0]?.step, details).toBe("gate");
        expect(ran[0]?.repo, details).toBe(task.task.repo);
        expect(ran[0]?.committed, details).toBe(true);
        expect(ran[0]?.config, details).toEqual(gateOptions);
        expect(taskLog(worker, task.task.task_key), details).toContain(
          `🧩 Pipeline: workspace-repo (${gatePath}): implement → commit → gate → finalize`,
        );
      }

      // halt: the task is handed back incomplete with the step's reason, and
      // `finalize` never runs (no publish push, no PR attempt).
      for (const halted of [strict, preserved]) {
        const log = taskLog(worker, halted.task.task_key);
        expect(halted.run.status, details).toBe("escalated");
        expect(halted.run.outcome_reason, details).toStartWith(
          "gate: policy gate blocked delivery",
        );
        expect(halted.run.pr_url, details).toBeNull();
        expect(log, details).toContain("✅ Successfully committed changes");
        expect(log, details).not.toContain("📤 Pushing branch to remote");
        expect(log, details).not.toContain("Creating pull request");
        const incomplete = join(
          worker.env.DEVINTERN_OUTPUT_DIR!,
          halted.task.task_key,
          "implementation-summary-incomplete.md",
        );
        expect(readFileSync(incomplete, "utf8"), details).toStartWith(
          "Pipeline stopped: policy gate blocked delivery",
        );
        const show = await worker.runCli([
          "worker",
          "runs",
          "show",
          String(halted.run.id),
          "--json",
        ]);
        expect(show.exitCode, show.stderr).toBe(0);
        const shown = JSON.parse(show.stdout) as {
          run: { status: string; failureStage?: string; failureCause?: string };
          stages: Array<{ stage: string; status: string }>;
        };
        expect(shown.run.failureStage, show.stdout).toBe("gate");
        expect(shown.run.failureCause, show.stdout).toBe("policy gate blocked delivery");
        expect(shown.stages.find((stage) => stage.stage === "implementation")?.status).toBe(
          "failed",
        );
      }

      // With preservation off the halted run pushes nothing at all.
      expect(await remoteRefs(worker, worker.remoteFor("strict")), details).toEqual([
        `refs/heads/${worker.baseBranch}`,
      ]);
      expect(strict.run.outcome_reason, details).not.toContain("work preserved");

      // Observed with default settings: unfinished-work preservation
      // (docs/code/delegation-runs.md) pushes the halted run's committed work
      // to its task branch so `--resume` continues from it. `finalize` still
      // did not run, so no PR was opened.
      const gatedRefs = await remoteRefs(worker, worker.remoteFor("gated"));
      expect(gatedRefs, details).toContain(`refs/heads/feature/${preserved.task.task_key}`);
      expect(preserved.run.outcome_reason, details).toContain(
        `work preserved on branch 'feature/${preserved.task.task_key}'`,
      );
      expect(taskLog(worker, preserved.task.task_key), details).toContain("Pushed unfinished work");

      // warn: the warning is printed after commit and delivery continues
      // through `finalize` to the push.
      const warnLog = taskLog(worker, warned.task.task_key);
      expect(warned.run.status, details).toBe("succeeded");
      expect(warned.run.outcome_reason, details).toBeNull();
      const committedAt = warnLog.indexOf("✅ Successfully committed changes");
      const warnedAt = warnLog.indexOf("⚠️  gate: policy gate blocked delivery");
      const pushedAt = warnLog.indexOf("📤 Pushing branch to remote");
      expect(committedAt, details).toBeGreaterThan(-1);
      expect(warnedAt, details).toBeGreaterThan(committedAt);
      expect(pushedAt, details).toBeGreaterThan(warnedAt);
      expect(warnLog, details).toContain("Creating pull request");
      expect(gatedRefs, details).toContain(`refs/heads/feature/${warned.task.task_key}`);
      expect(
        await worker.branchFile(`feature/${warned.task.task_key}`, "src/greeting.ts", "gated"),
      ).toBe(CANONICAL_GREETING);

      // A normal success-mode agent ran once per task: the pipeline is the
      // only variable.
      expect(
        worker.agentInvocations().map((entry) => entry.mode),
        details,
      ).toEqual(["implement", "implement", "implement"]);
      expect(worker.running, details).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);

cliTest(
  "workspace pipeline_file precedence: [[repos]] over [defaults], never merged, checkout pipeline ignored",
  async () => {
    const worker = new MultiRepoWorkerFixture(["repo-a", "repo-b"]);
    const markerDir = join(worker.root, "markers");
    try {
      await worker.prepare();
      const pipelinesDir = join(worker.workspaceDir, "pipelines");
      for (const name of ["repo-step", "fleet-step", "checkout-step"]) {
        writeMarkerPlugin(pipelinesDir, name);
      }
      const repoPipeline = writePipelineFile(pipelinesDir, "repo-a.json", {
        plugins: ["./steps/repo-step.ts"],
        steps: [
          { use: "implement" },
          { use: "commit" },
          { use: "repo-step", markerDir, scope: "repo" },
          { use: "finalize" },
        ],
      });
      const defaultPipeline = writePipelineFile(pipelinesDir, "default.json", {
        plugins: ["./steps/fleet-step.ts"],
        steps: [
          { use: "implement" },
          { use: "commit" },
          { use: "fleet-step", markerDir, scope: "defaults" },
          { use: "finalize" },
        ],
      });

      // Both repositories commit a legacy checkout pipeline whose own plugin
      // would leave a marker if it were ever read.
      const checkoutSettings = `${JSON.stringify(
        {
          pipeline: {
            plugins: [join(pipelinesDir, "steps/checkout-step.ts")],
            steps: [
              { use: "implement" },
              { use: "commit" },
              { use: "checkout-step", markerDir },
              { use: "finalize" },
            ],
          },
        },
        null,
        2,
      )}\n`;
      for (const repo of worker.repos) {
        const git = (...args: string[]) => checkedCommand(["git", ...args], repo.seed, worker.env);
        mkdirSync(join(repo.seed, ".devintern-code"), { recursive: true });
        writeFileSync(join(repo.seed, ".devintern-code", "settings.json"), checkoutSettings);
        // The fixture ignores `.devintern-code/`; a repository can still commit it.
        await git("add", "--force", ".devintern-code/settings.json");
        await git("commit", "-m", "Commit a legacy checkout pipeline");
        await git("push", "origin", worker.baseBranch);
      }

      const repoA = worker.repo("repo-a");
      const repoB = worker.repo("repo-b");
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
          'pipeline_file = "pipelines/default.json"',
          "",
          "[[repos]]",
          'name = "repo-a"',
          `remote = ${JSON.stringify(repoA.remote)}`,
          `default_branch = ${JSON.stringify(worker.baseBranch)}`,
          'pipeline_file = "pipelines/repo-a.json"',
          "",
          "[[repos]]",
          'name = "repo-b"',
          `remote = ${JSON.stringify(repoB.remote)}`,
          `default_branch = ${JSON.stringify(worker.baseBranch)}`,
          "",
        ].join("\n"),
      );

      const taskA = await worker.addTask({
        repo: "repo-a",
        title: "Precedence repo a",
        body: BODY,
      });
      const taskB = await worker.addTask({
        repo: "repo-b",
        title: "Precedence repo b",
        body: BODY,
      });
      worker.start();
      await worker.waitForReady();

      const a = await settle(worker, taskA);
      const b = await settle(worker, taskB);
      const markers = readStepMarkers(markerDir);
      const details = diagnostics(worker, [a, b, markers]);

      expect(a.run.status, details).toBe("succeeded");
      expect(b.run.status, details).toBe("succeeded");

      // Exactly one complete definition per task: A ran only its own step, B
      // only the fleet default's, and the checkout pipeline's step never ran.
      expect(
        markers.map((marker) => [marker.taskKey, marker.step, marker.repo, marker.config.scope]),
        details,
      ).toEqual([
        [a.task.task_key, "repo-step", "repo-a", "repo"],
        [b.task.task_key, "fleet-step", "repo-b", "defaults"],
      ]);
      expect(taskLog(worker, a.task.task_key), details).toContain(
        `🧩 Pipeline: workspace-repo (${repoPipeline}): implement → commit → repo-step → finalize`,
      );
      expect(taskLog(worker, b.task.task_key), details).toContain(
        `🧩 Pipeline: workspace-default (${defaultPipeline}): implement → commit → fleet-step → finalize`,
      );

      // The committed checkout pipeline is reported as ignored, per repo.
      for (const repo of ["repo-a", "repo-b"]) {
        expect(worker.logs, details).toMatch(
          new RegExp(
            `worktrees/${repo}/[^\\s]+/\\.devintern-code/settings\\.json defines a pipeline, which is not read`,
          ),
        );
      }

      for (const [run, repo] of [
        [a, "repo-a"],
        [b, "repo-b"],
      ] as const) {
        const branch = `feature/${run.task.task_key}`;
        expect(await worker.repoBranches(repo), details).toContain(branch);
        expect(await worker.repoBranchFile(repo, branch, "src/greeting.ts")).toBe(
          CANONICAL_GREETING,
        );
      }
      expect(worker.running, details).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);

cliTest(
  "a missing or invalid workspace pipeline_file fails the run closed before the agent starts",
  async () => {
    const worker = new WorkerFixture({
      repos: ["missing", "order", "reserved"],
      repoTomlExtra: {
        missing: 'pipeline_file = "pipelines/does-not-exist.json"',
        order: 'pipeline_file = "pipelines/order.json"',
        reserved: 'pipeline_file = "pipelines/reserved.json"',
      },
    });
    const markerDir = join(worker.root, "markers");
    try {
      await worker.prepare();
      const pipelinesDir = join(worker.workspaceDir, "pipelines");
      writeMarkerPlugin(pipelinesDir, "gate");
      // A plugin that claims a reserved built-in step name.
      writeMarkerPlugin(pipelinesDir, "verify");
      const missingPath = join(pipelinesDir, "does-not-exist.json");
      const orderPath = writePipelineFile(pipelinesDir, "order.json", {
        plugins: ["./steps/gate.ts"],
        steps: [
          { use: "implement" },
          { use: "commit" },
          { use: "finalize" },
          { use: "gate", markerDir },
        ],
      });
      const reservedPath = writePipelineFile(pipelinesDir, "reserved.json", {
        plugins: ["./steps/verify.ts"],
        steps: [{ use: "implement" }, { use: "commit" }, { use: "finalize" }],
      });

      const cases = [
        {
          repo: "missing",
          file: missingPath,
          error: `Invalid pipeline configuration for repository "missing": Cannot read pipeline file ${missingPath}: ENOENT`,
        },
        {
          repo: "order",
          file: orderPath,
          error: `Invalid pipeline configuration for repository "order" (workspace-repo (${orderPath}): implement → commit → finalize → gate): Pipeline step 'gate' cannot follow finalize`,
        },
        {
          repo: "reserved",
          file: reservedPath,
          error: `Invalid pipeline configuration for repository "reserved" (workspace-repo (${reservedPath}): implement → commit → finalize): Pipeline step name 'verify' is reserved`,
        },
      ];
      const tasks: WorkerInjectedTask[] = [];
      for (const entry of cases) {
        tasks.push(
          await worker.addTask({
            repo: entry.repo,
            title: `Invalid pipeline ${entry.repo}`,
            body: BODY,
          }),
        );
      }
      worker.start();
      await worker.waitForReady();

      for (const [index, entry] of cases.entries()) {
        const { task, run } = await settle(worker, tasks[index]!);
        const log = taskLog(worker, task.task_key);
        const details = diagnostics(worker, [entry.repo, task, run]);
        expect(task.status, details).toBe("failed");
        expect(run.status, details).toBe("failed");
        // The durable reason names the repository and the file (it may be
        // truncated after them); the task log carries the full error.
        expect(run.outcome_reason, details).toContain(`repository "${entry.repo}"`);
        expect(run.outcome_reason, details).toContain(entry.file);
        expect(log, details).toContain(entry.error);
        // No fallback to the built-in pipeline: nothing ran past selection.
        expect(log, details).not.toContain("🧩 Pipeline:");
        expect(log, details).not.toContain("🚀 Launching");
        expect(log, details).not.toContain("Committing changes");
        expect(run.pr_url, details).toBeNull();
        expect(await remoteRefs(worker, worker.remoteFor(entry.repo)), details).toEqual([
          `refs/heads/${worker.baseBranch}`,
        ]);
      }

      // Observed: validation runs before the agent, so it was never started
      // and no plugin step ran.
      expect(worker.agentInvocations(), diagnostics(worker)).toEqual([]);
      expect(readStepMarkers(markerDir), diagnostics(worker)).toEqual([]);
      expect(worker.running, diagnostics(worker)).toBe(true);
    } finally {
      await worker.dispose();
    }
  },
  120_000,
);
