/**
 * docs-drift-guard preset runner.
 *
 * After new commits merge into the repository's authoritative default
 * branch, this preset analyzes behavior-changing code against the
 * documentation set (docs/**, AGENTS.md, CLAUDE.md, README*) and publishes
 * the result either as deduplicated tracker tickets or as a
 * documentation-only pull request against the default branch.
 *
 * Checkpoint discipline: the per-repository checkpoint SHA advances only
 * after a clean outcome (valid `no_drift`, no behavior changes, or all
 * side effects published). Any failure — analysis errors, invalid or
 * inconclusive agent output, publication failures — leaves the checkpoint
 * untouched so the next scheduled occurrence retries the same range.
 */

import { basename } from "path";

import type { PresetOutputMode } from "../preset-registry";
import { AutomationCheckpointStore } from "../checkpoint-store";
import { defaultAgentPort } from "./agent-port";
import type { DocsDriftAgentPort } from "./agent-port";
import { collectDiffContext, hasNoBehaviorChanges } from "./diff-context";
import type { DiffContext } from "./diff-context";
import { defaultGitPort } from "./git-port";
import type { DocsDriftGitPort } from "./git-port";
import { isDocumentationPath, resolveDocPatterns } from "./paths";
import { buildDocsApplyPrompt, buildDocsDriftAnalysisPrompt } from "./prompt";
import { defaultPrPort, defaultTrackerPort, driftPrMarker, driftTicketMarker } from "./ports";
import type { DocsDriftPrPort, DocsDriftTrackerPort } from "./ports";
import { parseDocsDriftAnalysis } from "./result";
import type { DriftFinding } from "./result";
import { RunStore } from "../../run-recorder";
import type { CreateIssueInput, CreatedIssue, TaskTrackerClient } from "../../task-tracker-client";
import { supportsIssueCreation } from "../../tracker-capabilities";
import { PRESET_VERSION } from "./constants";

export interface DocsDriftRunInput {
  automationId: string;
  /** Repository worktree the run executes in. */
  cwd: string;
  /** Repository name for checkpoint keying (defaults to the cwd basename). */
  repoName?: string;
  /** Queue database path for checkpoints and run records. */
  dbPath: string;
  outputMode: PresetOutputMode;
  /** Documentation path pattern overrides. */
  docPaths?: string[];
  /** Explicit first-run starting point; defaults to the current head. */
  baselineSha?: string;
  signal?: AbortSignal;
}

export interface DocsDriftRunDeps {
  git?: DocsDriftGitPort;
  agent?: DocsDriftAgentPort;
  tracker?: DocsDriftTrackerPort | null;
  pr?: DocsDriftPrPort;
  checkpoints?: AutomationCheckpointStore;
  /** `null` disables run-record persistence (tests). */
  runStore?: RunStore | null;
  now?: () => number;
  /** Turn off the actual agent spawn in tests that only exercise plumbing. */
  buildAnalysisPrompt?: typeof buildDocsDriftAnalysisPrompt;
}

export interface DocsDriftRunOutcome {
  ok: boolean;
  reason?: string;
  fromSha?: string;
  toSha?: string;
  /** Finding ids that produced a ticket/PR, or were deduplicated away. */
  created?: Array<{ kind: "ticket" | "pr"; key?: string; url?: string }>;
  deduplicated?: Array<{ findingId: string; existingKey: string }>;
}

const SEVERITY_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };
const MAX_TICKET_TITLE = 110;

function ticketTitle(finding: DriftFinding): string {
  const title = `[docs-drift] ${finding.summary}`;
  return title.length > MAX_TICKET_TITLE ? `${title.slice(0, MAX_TICKET_TITLE - 1)}…` : title;
}

function ticketBody(input: {
  finding: DriftFinding;
  repository: string;
  commitRange: string;
  automationId: string;
  marker: string;
}): string {
  const { finding, repository, commitRange, automationId, marker } = input;
  const evidence = finding.evidence
    .map((entry) => {
      const parts = [
        entry.commit ? `commit \`${entry.commit.slice(0, 12)}\`` : null,
        entry.file ? `\`${entry.file}\`` : null,
        entry.detail ?? null,
      ].filter(Boolean);
      return `- ${parts.join(" — ")}`;
    })
    .join("\n");

  const lines: string[] = [
    "## Documentation drift detected",
    "",
    `**Behavior change:** ${finding.affectedBehavior}`,
    "",
    `**Required update:** ${finding.proposedChange}`,
  ];
  if (finding.severity) {
    lines.push("", `**Severity:** ${finding.severity}`);
  }
  lines.push(
    "",
    "### Evidence",
    evidence || "(none provided)",
    "",
    "### Affected documentation",
    finding.targetDocuments.map((doc) => `- \`${doc}\``).join("\n"),
    "",
    "### Provenance",
    `- Repository: ${repository}`,
    `- Evaluated range: \`${commitRange}\``,
    `- Preset: docs-drift-guard v${PRESET_VERSION} (automation \`${automationId}\`)`,
    "",
    "Findings summarize merged commits and are generated automatically; verify",
    "against the linked commits before editing documentation.",
    "",
    `<!-- ${marker} -->`,
  );
  return lines.join("\n");
}

function prBody(input: {
  findings: DriftFinding[];
  repository: string;
  fromSha: string;
  toSha: string;
  automationId: string;
  marker: string;
}): string {
  const { findings, repository, fromSha, toSha, automationId, marker } = input;
  return [
    "## Documentation drift sync",
    "",
    `Automated documentation update for \`${repository}\` covering merged commits`,
    `\`${fromSha.slice(0, 12)}..${toSha.slice(0, 12)}\`.`,
    "",
    "### Drift findings addressed",
    findings
      .map(
        (finding, index) =>
          `${index + 1}. **${finding.summary}** — ${finding.proposedChange} (docs: ${finding.targetDocuments.join(", ")})`,
      )
      .join("\n"),
    "",
    `Preset: docs-drift-guard v${PRESET_VERSION} (automation \`${automationId}\`).`,
    "Documentation-only changes; no code is modified by this automation.",
    "",
    `<!-- ${marker} -->`,
  ].join("\n");
}

/** Sort findings deterministically: severity desc, then stable id. */
export function sortFindings(findings: DriftFinding[]): DriftFinding[] {
  return [...findings].sort((a, b) => {
    const severityDelta =
      (SEVERITY_WEIGHT[b.severity ?? "medium"] ?? 2) -
      (SEVERITY_WEIGHT[a.severity ?? "medium"] ?? 2);
    if (severityDelta !== 0) return severityDelta;
    return a.id.localeCompare(b.id);
  });
}

/** Execute one docs-drift-guard occurrence. Returns whether it completed. */
export async function runDocsDriftGuard(
  input: DocsDriftRunInput,
  deps: DocsDriftRunDeps = {},
): Promise<DocsDriftRunOutcome> {
  const git = deps.git ?? defaultGitPort;
  const agent = deps.agent ?? defaultAgentPort;
  const docPatterns = resolveDocPatterns({ docPaths: input.docPaths });
  const repoKey = input.repoName ?? basename(input.cwd);
  const abortCheck = (): boolean => input.signal?.aborted ?? false;

  const ownsCheckpoints = !deps.checkpoints;
  const checkpoints = deps.checkpoints ?? new AutomationCheckpointStore(input.dbPath);
  const ownsRunStore = deps.runStore === undefined;
  const runStore = ownsRunStore ? new RunStore(input.dbPath) : deps.runStore;

  let runId: number | null = null;
  try {
    runId =
      runStore?.createRun({
        origin: "scheduled",
        taskKey: `docs-drift-guard/${repoKey}`,
        automationId: input.automationId,
        repo: repoKey,
        tracker: process.env.TASK_TRACKER,
      }) ?? null;
  } catch (error) {
    console.warn(`⚠️  [docs-drift-guard] could not record run: ${(error as Error).message}`);
  }

  const fail = (reason: string): DocsDriftRunOutcome => {
    console.error(`❌ [automation:${input.automationId}] docs-drift-guard failed: ${reason}`);
    try {
      if (runId !== null) runStore?.finishRun(runId, "failed", reason);
    } catch {
      // Recording is best-effort.
    }
    return { ok: false, reason };
  };

  const succeed = (reason: string, outcome: Partial<DocsDriftRunOutcome> = {}) => {
    console.log(`✅ [automation:${input.automationId}] docs-drift-guard: ${reason}`);
    try {
      if (runId !== null) runStore?.finishRun(runId, "succeeded", reason);
    } catch {
      // Recording is best-effort.
    }
    return { ok: true, reason, ...outcome };
  };

  try {
    // ------------------------------------------------------------------
    // Phase 0: environment prerequisites (fail before any expensive work).
    // ------------------------------------------------------------------
    if (await git.isShallow(input.cwd)) {
      return fail(
        "the repository is a shallow clone; docs-drift-guard needs full history. " +
          "Clone with --filter=blob:none instead of --depth, or unset shallow settings.",
      );
    }
    const remoteUrl = await git.remoteUrl(input.cwd);
    if (input.outputMode === "pull_request" && (!remoteUrl || !remoteUrl.includes("github.com"))) {
      return fail(
        'output_mode "pull_request" requires a GitHub origin remote (PR creation and reuse are GitHub-only).',
      );
    }

    let trackerClient: TaskTrackerClient | undefined;
    if (input.outputMode === "ticket") {
      if (deps.tracker === null) {
        return fail('output_mode "ticket" requires a configured task tracker.');
      }
      const trackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();
      if (!deps.tracker && !supportsIssueCreation().includes(trackerType)) {
        return fail(
          `tracker "${trackerType}" cannot create tickets; docs-drift-guard ticket mode supports: ` +
            `${["github", "gitlab"].join(", ")}. Switch output_mode to "pull_request" or use a supported tracker.`,
        );
      }
      if (!deps.tracker) {
        const { TaskTrackerManager } = await import("../../task-tracker-manager");
        trackerClient = new TaskTrackerManager().getClient();
      }
    }

    // ------------------------------------------------------------------
    // Phase 1: resolve default branch + head, then the checkpoint range.
    // ------------------------------------------------------------------
    if (abortCheck()) return fail("run aborted before analysis");
    const defaultBranch = await git.resolveDefaultBranch(input.cwd);
    const fetched = await git.fetchBranch(input.cwd, defaultBranch);
    if (!fetched) {
      console.warn(
        `⚠️  [automation:${input.automationId}] could not fetch origin/${defaultBranch}; using the last known state`,
      );
    }
    const headRef = fetched ? `origin/${defaultBranch}` : defaultBranch;
    const head = await git.revParse(input.cwd, headRef);
    if (!head) return fail(`could not resolve ${headRef} to a commit`);

    const checkpoint = checkpoints.get(repoKey, input.automationId);
    let fromSha: string;
    if (!checkpoint) {
      if (input.baselineSha) {
        const resolvedBaseline = await git.revParse(input.cwd, input.baselineSha);
        if (!resolvedBaseline) {
          return fail(`baseline_sha "${input.baselineSha}" does not resolve to a commit`);
        }
        if (!(await git.isAncestor(input.cwd, resolvedBaseline, head))) {
          return fail(
            `baseline_sha "${input.baselineSha}" is not an ancestor of ${defaultBranch}; pick a commit on the default branch`,
          );
        }
        fromSha = resolvedBaseline;
      } else {
        // First run without an explicit baseline: bound the audit at the
        // current head so enabling the preset never back-audits history.
        checkpoints.set(repoKey, input.automationId, "docs-drift-guard", head);
        return succeed(`baseline established at ${head.slice(0, 12)} (no analysis performed)`, {
          toSha: head,
        });
      }
    } else {
      fromSha = checkpoint.lastProcessedSha;
      if (!(await git.isAncestor(input.cwd, fromSha, head))) {
        return fail(
          `checkpoint ${fromSha.slice(0, 12)} is no longer an ancestor of ${defaultBranch} ` +
            `(history rewritten or force-pushed). Set baseline_sha to re-baseline explicitly.`,
        );
      }
    }

    if (fromSha === head) {
      return succeed("no new commits since the last successful run", { fromSha, toSha: head });
    }

    // ------------------------------------------------------------------
    // Phase 2: deterministic diff context (cheap, no agent).
    // ------------------------------------------------------------------
    if (abortCheck()) return fail("run aborted before analysis");
    const context: DiffContext = await collectDiffContext(git, {
      cwd: input.cwd,
      fromSha,
      toSha: head,
      docPatterns,
    });

    const recordAnalysisStage = (detail: Record<string, unknown>): void => {
      try {
        if (runId !== null) {
          runStore?.addStage(
            runId,
            "implementation",
            "succeeded",
            "analysis",
            JSON.stringify(detail),
          );
        }
      } catch {
        // Recording is best-effort.
      }
    };

    if (hasNoBehaviorChanges(context)) {
      checkpoints.set(repoKey, input.automationId, "docs-drift-guard", head);
      recordAnalysisStage({
        range: `${fromSha}..${head}`,
        behaviorFiles: 0,
        truncated: context.truncated,
      });
      return succeed("no behavior-changing commits (documentation-only or ignored changes)", {
        fromSha,
        toSha: head,
      });
    }

    // ------------------------------------------------------------------
    // Phase 3: agent analysis with structured output validation.
    // ------------------------------------------------------------------
    if (abortCheck()) return fail("run aborted before analysis");
    const repository = (await git.repositorySlug(input.cwd)) ?? repoKey;
    const raw = await agent.run({
      prompt: buildDocsDriftAnalysisPrompt({ context, repository, defaultBranch }),
      cwd: input.cwd,
      mode: "analyze",
    });
    const parsed = parseDocsDriftAnalysis(raw);
    if (!parsed.ok) {
      return fail(`inconclusive: ${parsed.reason} (checkpoint preserved for retry)`);
    }
    const analysis = parsed.analysis;
    if (analysis.status === "inconclusive") {
      return fail(
        `inconclusive: the agent could not verify the documentation (${analysis.notes ?? "no notes"}); checkpoint preserved for retry`,
      );
    }
    recordAnalysisStage({
      range: `${fromSha}..${head}`,
      truncated: context.truncated,
      status: analysis.status,
      findings: analysis.findings.map((finding) => ({ id: finding.id, summary: finding.summary })),
      notes: analysis.notes,
    });

    if (analysis.status === "no_drift" || analysis.findings.length === 0) {
      checkpoints.set(repoKey, input.automationId, "docs-drift-guard", head);
      return succeed("no documentation drift detected", { fromSha, toSha: head });
    }

    // ------------------------------------------------------------------
    // Phase 4: publish side effects; checkpoint advances only afterwards.
    // ------------------------------------------------------------------
    if (abortCheck()) return fail("run aborted before publication");
    const findings = sortFindings(analysis.findings);

    if (input.outputMode === "ticket") {
      const trackerPort = deps.tracker ?? defaultTrackerPort(trackerClient as TaskTrackerClient);
      const commitRange = `${fromSha.slice(0, 12)}..${head.slice(0, 12)}`;
      const created: NonNullable<DocsDriftRunOutcome["created"]> = [];
      const deduplicated: NonNullable<DocsDriftRunOutcome["deduplicated"]> = [];

      for (const finding of findings) {
        const marker = driftTicketMarker(finding.id);
        const existing = await trackerPort.findOpenWithMarker(marker);
        if (existing.length > 0) {
          deduplicated.push({ findingId: finding.id, existingKey: existing[0].key });
          continue;
        }
        const issue: CreateIssueInput = {
          title: ticketTitle(finding),
          body: ticketBody({
            finding,
            repository,
            commitRange,
            automationId: input.automationId,
            marker,
          }),
        };
        let result: CreatedIssue;
        try {
          result = await trackerPort.create(issue);
        } catch (error) {
          return fail(`ticket creation failed: ${(error as Error).message}`);
        }
        created.push({ kind: "ticket", key: result.key, url: result.url });
      }

      // All publication succeeded — safe to advance.
      checkpoints.set(repoKey, input.automationId, "docs-drift-guard", head);
      return succeed(
        created.length > 0
          ? `created ${created.length} documentation drift ticket(s)${deduplicated.length > 0 ? `; ${deduplicated.length} deduplicated` : ""}`
          : `all findings already tracked (${deduplicated.length} deduplicated)`,
        { fromSha, toSha: head, created, deduplicated },
      );
    }

    // pull_request mode
    const prPort = deps.pr ?? defaultPrPort();
    const slug = await git.repositorySlug(input.cwd);
    if (!slug) return fail("could not determine the owner/repo slug from the origin remote");

    if (!(await git.isWorkingTreeClean(input.cwd))) {
      return fail(
        "the worktree has uncommitted changes; docs-drift-guard refuses to publish from a dirty tree",
      );
    }

    const branchName = `docs-drift/${input.automationId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${head.slice(0, 8)}`;
    const marker = driftPrMarker(input.automationId);
    const existing = await prPort.findOpenDriftPr({ repository: slug, marker });
    const reuse = existing !== null;
    const targetBranch = reuse ? existing.headRef : branchName;

    const originalBranch = await git.currentBranch(input.cwd);
    try {
      // Reuse policy: reset the existing PR branch onto the new head so the
      // documentation is regenerated deterministically for this range.
      await git.checkoutBranchAt(input.cwd, targetBranch, head);
      await agent.run({
        prompt: buildDocsApplyPrompt({
          findings,
          allowedPaths: docPatterns,
          commitRange: `${fromSha.slice(0, 12)}..${head.slice(0, 12)}`,
        }),
        cwd: input.cwd,
        mode: "apply",
      });

      const changedPaths = await git.workingTreePaths(input.cwd);
      const docPaths = changedPaths.filter((path) => isDocumentationPath(path, docPatterns));
      if (docPaths.length === 0) {
        throw new Error(
          "the documentation agent produced no changes within the allowed doc paths; refusing to publish an empty PR",
        );
      }
      await git.stagePaths(input.cwd, docPaths);
      await git.commit(
        input.cwd,
        `docs: sync documentation with ${fromSha.slice(0, 8)}..${head.slice(0, 8)} [docs-drift ${input.automationId}]`,
      );
      await git.pushBranch(input.cwd, targetBranch, reuse);

      const body = prBody({
        findings,
        repository: slug,
        fromSha,
        toSha: head,
        automationId: input.automationId,
        marker,
      });
      let prRef: { number?: number; url?: string };
      if (reuse && existing) {
        await prPort.updatePullRequestBody({ repository: slug, prNumber: existing.number, body });
        prRef = { number: existing.number, url: existing.url };
      } else {
        prRef = await prPort.createPullRequest({
          repository: slug,
          title: `docs: sync documentation with merged behavior [docs-drift ${input.automationId}]`,
          body,
          head: targetBranch,
          base: defaultBranch,
        });
      }
      try {
        if (runId !== null) {
          runStore?.setRunPr(runId, { repo: slug, prNumber: prRef.number, url: prRef.url });
        }
      } catch {
        // Recording is best-effort.
      }

      checkpoints.set(repoKey, input.automationId, "docs-drift-guard", head);
      return succeed(
        `${reuse ? "updated" : "opened"} documentation pull request ${prRef.url ?? prRef.number ?? ""}`.trim(),
        {
          fromSha,
          toSha: head,
          created: [
            {
              kind: "pr",
              key: prRef.number === undefined ? undefined : String(prRef.number),
              url: prRef.url,
            },
          ],
        },
      );
    } finally {
      // Always put the worktree back on its original branch. A failed
      // restore must not mask the real failure reason: the next run's
      // dirty-tree check rejects a messy worktree, so log loudly instead.
      if (originalBranch) {
        try {
          await git.checkout(input.cwd, originalBranch);
        } catch (restoreError) {
          console.error(
            `❌ [automation:${input.automationId}] could not restore branch "${originalBranch}": ` +
              `${(restoreError as Error).message}; clean up the worktree manually`,
          );
        }
      }
    }
  } catch (error) {
    return fail((error as Error).message);
  } finally {
    if (ownsCheckpoints) checkpoints.close();
    if (ownsRunStore) runStore?.close();
  }
}
