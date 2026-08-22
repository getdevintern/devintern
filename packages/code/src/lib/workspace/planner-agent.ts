/**
 * Agent-generated multi-repo planning.
 *
 * When fleet routing cannot pick a single repository (rules match two or
 * more repos), a coordinated task may span several of them. The planner asks
 * the configured agent to select the affected repositories using the
 * workspace's routing hints (purpose, owned paths/domains, capabilities,
 * dependencies) plus the task text, and to explain each choice.
 *
 * The planner fails safely: an empty or invalid selection never mutates any
 * repository — validation happens before orchestration touches git. The
 * agent spawn itself is injectable so tests cover routing/validation logic
 * without a real CLI.
 */

import type { WorkspaceConfig } from "./config";
import { parsePlanEntries, validateAndOrderPlan } from "./plan";
import type { MultiRepoPlan, PlanEntry } from "./plan";

/** Everything the planner knows about the task being planned. */
export interface PlanningTaskInput {
  taskKey: string;
  title?: string;
  description?: string;
  /**
   * Repository names the deterministic routing rules matched (the ambiguous
   * candidate set). Empty when planning was requested directly.
   */
  candidates: string[];
}

/** Result of one planning attempt (never partially valid). */
export type PlannerResult =
  | {
      ok: true;
      entries: PlanEntry[];
      /** Deterministic topological execution order of `entries`. */
      executionOrder: string[];
    }
  | { ok: false; errors: string[] };

/** Render one repo's routing hints as compact prompt context. */
function describeRepo(config: WorkspaceConfig, name: string): string {
  const repo = config.repos.find((candidate) => candidate.name === name);
  if (!repo?.hints) {
    return `- ${name} (no hints)`;
  }
  const lines = [`- ${name}`];
  if (repo.hints.purpose) {
    lines.push(`  purpose: ${repo.hints.purpose}`);
  }
  if (repo.hints.domains.length > 0) {
    lines.push(`  domains: ${repo.hints.domains.join(", ")}`);
  }
  if (repo.hints.capabilities.length > 0) {
    lines.push(`  capabilities provided: ${repo.hints.capabilities.join(", ")}`);
  }
  if (repo.hints.ownedPaths.length > 0) {
    lines.push(`  owned paths: ${repo.hints.ownedPaths.join(", ")}`);
  }
  if (repo.hints.dependsOn.length > 0) {
    lines.push(`  depends on: ${repo.hints.dependsOn.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Build the planning prompt: task context plus every configured repo's
 * routing hints, with strict output-shape rules.
 */
export function buildPlanningPrompt(input: PlanningTaskInput, config: WorkspaceConfig): string {
  const sections = [
    "You are planning a coordinated change across a multi-repository workspace.",
    "",
    "## Task",
    `Key: ${input.taskKey}`,
    input.title ? `Title: ${input.title}` : undefined,
    input.description ? `Description:\n${input.description.trim()}` : undefined,
    input.candidates.length > 0
      ? `Routing rules matched these repositories (candidates): ${input.candidates.join(", ")}`
      : undefined,
    "",
    "## Workspace repositories",
    ...config.repos.map((repo) => describeRepo(config, repo.name)),
    "",
    "## Rules",
    "- Select EVERY repository that must change for this task, including repositories needed to support changes in another selected one.",
    "- If repository A's code consumes something repository B must change first, A lists B in its dependencies.",
    "- If the task clearly concerns only one repository, select just that one.",
    "- Use ONLY repository names exactly as listed above.",
    "- Do not guess: if you cannot confidently determine the affected set, respond with an empty list.",
    "",
    "## Output",
    "Respond with ONLY a JSON object of this exact shape (no prose around it):",
    "```json",
    "{",
    '  "repos": [',
    "    {",
    '      "repo": "<repository name>",',
    '      "rationale": "<why this repository is part of the effort>",',
    '      "change": "<what should change in this repository>",',
    '      "dependencies": ["<other selected repository names whose work must finish first>"]',
    "    }",
    "  ]",
    "}",
    "```",
  ];
  return sections.filter((section) => section !== undefined).join("\n");
}

/** Default planning timeout in minutes (planning is a short analysis task). */
const DEFAULT_PLANNING_TIMEOUT_MINUTES = 10;

/**
 * Run the planning prompt through the configured agent CLI and return raw
 * stdout. Mirrors the internal analysis spawns (clarity check, estimation):
 * unattended mode, captured stdout, hard timeout.
 *
 * @throws When the CLI is missing, times out, exits nonzero, or produces
 *         empty output.
 */
export async function runPlanningAgentWithHarness(
  prompt: string,
  workingDir?: string,
): Promise<string> {
  const { buildPromptArgs, reapTree, resolveExecutablePathWithRetry, resolveHarness, spawnAgent } =
    await import("@devintern/agent-harness");

  const resolved = resolveHarness();
  const executablePath = await resolveExecutablePathWithRetry(resolved.path, {
    displayName: resolved.harness.displayName,
  });

  // Planning only needs to reason about the prompt; a modest turn cap keeps
  // a confused agent from wandering through every repo.
  const maxTurns = Number.parseInt(process.env.AGENT_PLANNING_MAX_TURNS || "12", 10);
  const args = resolved.harness.buildArgs({
    maxTurns,
    skipPermissions: true,
    ...(workingDir ? { workingDir } : {}),
  });
  const { getSandbox } = await import("../sandbox");

  console.log(`🧠 Planning coordinated task with ${resolved.harness.displayName}...`);

  return new Promise<string>((resolvePromise, rejectPromise) => {
    void (async () => {
      let stdout = "";
      let timedOut = false;

      const timeoutMinutes = Number.parseInt(
        process.env.AGENT_PLANNING_TIMEOUT_MINUTES || String(DEFAULT_PLANNING_TIMEOUT_MINUTES),
        10,
      );

      let child;
      let cleanupSandbox: () => Promise<void> = async () => {};
      try {
        const spawned = await spawnAgent({
          resolvedPath: executablePath,
          args: [...args, ...buildPromptArgs(resolved.harness, prompt)],
          spawnOptions: {
            stdio: ["ignore", "pipe", "pipe"],
            ...(workingDir ? { cwd: workingDir } : {}),
          },
          sandbox: await getSandbox(resolved.harness.name),
        });
        child = spawned.child;
        cleanupSandbox = spawned.cleanup;
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const timeout = setTimeout(
        () => {
          timedOut = true;
          reapTree(child, "SIGTERM");
          setTimeout(() => {
            if (!child.killed) {
              reapTree(child, "SIGKILL");
            }
            cleanupSandbox().catch(() => {});
          }, 10_000);
        },
        timeoutMinutes * 60 * 1000,
      );

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", () => {
        /* planning stderr is noise; stdout carries the JSON */
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        cleanupSandbox().catch(() => {});
        rejectPromise(
          error.code === "ENOENT"
            ? new Error(
                `${resolved.harness.displayName} CLI not found at: ${executablePath}. ` +
                  "Install it or configure the workspace planner differently.",
              )
            : new Error(`Planning agent failed to start: ${error.message}`),
        );
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        cleanupSandbox().catch(() => {});
        if (timedOut) {
          rejectPromise(new Error(`Planning agent timed out after ${timeoutMinutes} minutes`));
          return;
        }
        if (code !== 0) {
          rejectPromise(new Error(`Planning agent exited with code ${code}`));
          return;
        }
        if (!stdout.trim()) {
          rejectPromise(new Error("Planning agent produced no output"));
          return;
        }
        resolvePromise(stdout);
      });
    })();
  });
}

export interface MultiRepoPlannerDeps {
  config: WorkspaceConfig;
  /** Working directory offered to the planning agent (defaults: unset). */
  workingDir?: string;
  /** Agent runner (injected for tests; defaults to {@link runPlanningAgentWithHarness}). */
  runAgent?: (prompt: string) => Promise<string>;
}

/**
 * Build the multi-repo planner: prompt the agent, parse the response, and
 * validate the proposed selection BEFORE returning it. Never returns a
 * partially valid result — callers can mutate repositories as soon as they
 * see `{ ok: true }`.
 */
export function createMultiRepoPlanner(
  deps: MultiRepoPlannerDeps,
): (input: PlanningTaskInput) => Promise<PlannerResult> {
  const runAgent = deps.runAgent ?? runPlanningAgentWithHarness;

  return async (input) => {
    let output: string;
    try {
      output = await runAgent(buildPlanningPrompt(input, deps.config));
    } catch (error) {
      return { ok: false, errors: [`Planning agent failed: ${(error as Error).message}`] };
    }

    let entries: PlanEntry[];
    try {
      entries = parsePlanEntries(output);
    } catch (error) {
      return { ok: false, errors: [(error as Error).message] };
    }

    const validation = validateAndOrderPlan(entries, deps.config);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    return { ok: true, entries, executionOrder: validation.executionOrder };
  };
}

/** Convenience: validate entries and assemble the persisted plan object. */
export function assemblePlan(
  input: PlanningTaskInput,
  coordinationId: string,
  entries: PlanEntry[],
  executionOrder: string[],
): MultiRepoPlan {
  return {
    taskKey: input.taskKey,
    coordinationId,
    entries,
    executionOrder,
  };
}
