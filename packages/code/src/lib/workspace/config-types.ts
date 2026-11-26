/** Parsed `workspace.toml` shapes. Parsing lives in `config.ts`, which re-exports these. */

import type { AutomationConfig, CronOrIntervalSchedule } from "../automation/config";
import type { WorkerScheduleConfig } from "../worker/schedule";
import type { EstimationConfig } from "../automation/estimation-config";
import type { AgentSelection } from "../agent/selection";
import type { AutoMergeMethod, MergeSafetyPolicy } from "../review/merge-gate";
import type { DashboardAllowedOrigin } from "../observability/dashboard-origins";
import type { DependencyMode } from "../dependencies/gate";

/** When automatic conflict resolution on the agent's PRs runs. */
export type ConflictResolutionMode = "auto" | "scheduled" | "disabled";

/** Execution isolation available in the host-concurrency release. */
export type WorkspaceExecutionIsolation = "best_effort_host";

/** Workspace-wide agent admission settings. */
export interface WorkspaceExecutionSettings {
  /** Explicit acknowledgement that concurrent jobs share the host. */
  isolation?: WorkspaceExecutionIsolation;
  /** Maximum agent jobs admitted across the workspace. */
  maxConcurrency: number;
  /** Maximum disposable-worktree task jobs admitted for one repository. */
  maxConcurrencyPerRepo: number;
}

/** Workspace-wide settings from the `[workspace]` table. */
export interface WorkspaceSettings {
  /** Agent execution and concurrency settings from `[workspace.execution]`. */
  execution: WorkspaceExecutionSettings;
  /** Days before a leftover (failed-run) task worktree is swept. */
  worktreesTtlDays: number;
  /** Serve the local observability dashboard from the worker process. */
  dashboard: boolean;
  /** Dashboard listen port; unset follows DASHBOARD_PORT / 4400. */
  dashboardPort?: number;
  /** Automatically ask the agent to repair failing CI on its own open PRs. */
  ciFailureFix: boolean;
  /**
   * `auto` (default) resolves merge conflicts on the agent's PRs as soon as
   * they are detected; `scheduled` queues them during polling and resolves
   * them in the configured window (see {@link WorkspaceSettings.conflictSchedule});
   * `disabled` turns automatic conflict resolution off entirely — conflicts
   * stay for manual resolution (`devintern resolve-conflicts <pr-url>`).
   */
  conflictResolution: ConflictResolutionMode;
  /**
   * Cron-or-interval window for scheduled conflict resolution (same format
   * as `[[automations]]` schedules). Set only when `conflictResolution` is
   * `"scheduled"`.
   */
  conflictSchedule?: CronOrIntervalSchedule;
  /**
   * Agent for automatic conflict resolution, from the optional
   * `conflict_resolution_harness` / `_model` / `_effort` keys. Same semantics
   * as an automation's `harness` / `model` / `effort` (see
   * `agent/selection.ts`). Omitted when none of the keys is set.
   */
  conflictAgent?: AgentSelection;
  /** Auto-merge of the agent's own PRs (off by default). */
  autoMerge: AutoMergeSettings;
}

/**
 * Auto-merge of the agent's own PRs, from the `[workspace].auto_merge*` keys.
 * Off by default. See `review/auto-merge.ts` for the gate order.
 */
export interface AutoMergeSettings {
  enabled: boolean;
  /** GitHub merge strategy (`auto_merge_method`, default `squash`). */
  method: AutoMergeMethod;
  /**
   * Ask the agent about PRs that touch paths outside `safePaths`
   * (`auto_merge_review`, default true). When false, only PRs entirely
   * inside the safe paths merge.
   */
  review: boolean;
  /** Globs safe to merge without review (`auto_merge_safe_paths`). */
  safePaths: string[];
  /** Globs that block auto-merge entirely (`auto_merge_deny_paths`). */
  denyPaths: string[];
  /**
   * Globs whose changes always go to the agent review, even when they also
   * match a safe glob (`auto_merge_review_paths`).
   */
  reviewPaths: string[];
  /**
   * Label for PRs left open for a human, removed on merge
   * (`auto_merge_review_label`, default `needs-human-review`; `""` disables).
   */
  reviewLabel: string;
  /** Merge-safety review strictness (`auto_merge_policy`, default `strict`). */
  policy: MergeSafetyPolicy;
  /**
   * Review diffs too large to inline from the PR checkout
   * (`auto_merge_review_large_diffs`, default false: they stay open).
   */
  reviewLargeDiffs: boolean;
  /**
   * Operator rules appended to the merge-safety prompt
   * (`auto_merge_review_instructions`). Omitted when unset or empty.
   */
  reviewInstructions?: string;
  /** `custom` policy rubric text (`auto_merge_rules`). */
  rules?: string;
  /**
   * `custom` policy rubric file (`auto_merge_rules_file`) as written:
   * relative to the workspace home, `~` allowed. Read on every review.
   */
  rulesFile?: string;
  /** Agent for the merge-safety review (`auto_merge_harness` / `_model` / `_effort`). */
  agent?: AgentSelection;
}

/** Fleet-wide defaults from the `[defaults]` table. */
export interface WorkspaceDefaults {
  /** Tracker driving the fleet query (must support polling). */
  tracker: string;
  /** Tracker query the worker polls with. */
  taskQuery?: string;
  /** Extra per-task CLI flags (default `--create-pr`). */
  workerTaskArgs?: string;
  /** Labels applied to PRs created for repos that do not override them. */
  prLabels?: string[];
  /**
   * Workspace-relative JSON file holding the fleet-wide default pipeline
   * definition. Falls back to the built-in default when unset.
   */
  pipelineFile?: string;
  /** Seconds between tracker poll ticks. */
  pollIntervalSeconds: number;
  /**
   * How a task with dependencies waits (`dependency_mode`): `stacked` on one
   * unmerged dependency, or `merged` until every dependency PR merged.
   * Unset: resolved per repo by `resolveDependencyMode` (`stacked` for GitHub
   * repos, `merged` elsewhere).
   */
  dependencyMode?: DependencyMode;
}

/**
 * One team's tracker source from a `[[teams]]` entry.
 *
 * Teams let one fleet worker poll several boards/trackers (even several
 * boards of the same tracker type), each with its own credentials, query,
 * and cursor. Omitting `[[teams]]` keeps the single `[defaults]` behavior.
 */
export interface TeamConfig {
  /** Unique team name; namespaces cursors, dedupe, and skips (`jira:platform`). */
  name: string;
  /** Tracker driving this team's query (must support polling). */
  tracker: string;
  /** Tracker query the worker polls with for this team. */
  taskQuery?: string;
  /** Fixed destination repo. Omit when this team routes across several repos. */
  repo?: string;
  /** Optional env file with this team's credentials, relative to the workspace directory. */
  envFile?: string;
  /** Inline env overrides (highest precedence within the team). */
  env: Record<string, string>;
  /**
   * `dependency_mode` for this team's tracker tickets that have native
   * blockers; falls back to `[defaults].dependency_mode`.
   */
  dependencyMode?: DependencyMode;
}

/** One managed repository from a `[[repos]]` entry. */
export interface RepoConfig {
  /** Unique name; also the directory name under `repos/` and `worktrees/`. */
  name: string;
  /**
   * Git remote URL the bare clone tracks. Empty for a `manual_only` repo
   * registered by {@link RepoConfig.path} instead.
   */
  remote: string;
  /**
   * Absolute local checkout directory of a `manual_only` repo without a
   * recognised remote (for example a fresh `git init`). Manual runs started
   * in this directory, or below it, use this entry.
   */
  path?: string;
  /** Default branch task worktrees start from; falls back to `origin/HEAD`. */
  defaultBranch?: string;
  /** Labels applied to PRs created for this repo; falls back to `defaults.pr_labels`. */
  prLabels?: string[];
  /**
   * Workspace-relative JSON file holding this repository's pipeline override.
   * Takes precedence over the repo's checked-in `settings.json` pipeline and
   * over `[defaults].pipeline_file`.
   */
  pipelineFile?: string;
  /** Per-repo `auto_merge_safe_paths`; replaces the workspace list when set. */
  autoMergeSafePaths?: string[];
  /** Per-repo `auto_merge_deny_paths`; replaces the workspace list when set. */
  autoMergeDenyPaths?: string[];
  /** Per-repo `auto_merge_review_paths`; replaces the workspace list when set. */
  autoMergeReviewPaths?: string[];
  /** Per-repo `auto_merge_policy`; replaces the workspace policy when set. */
  autoMergePolicy?: MergeSafetyPolicy;
  /**
   * Per-repo `auto_merge_review_instructions`; replaces the workspace text
   * when set (`""` clears it for this repo).
   */
  autoMergeReviewInstructions?: string;
  /**
   * Per-repo `auto_merge_rules`; with `autoMergeRulesFile`, the repo's rules
   * source replaces the workspace's when either is set.
   */
  autoMergeRules?: string;
  /** Per-repo `auto_merge_rules_file` (unresolved, like the workspace key). */
  autoMergeRulesFile?: string;
  /** Optional env file path, relative to the workspace directory. */
  envFile?: string;
  /**
   * `sync_team_prs`: extend automatic base sync beyond the agent's own PRs to
   * this repo's open, non-draft, same-repo PRs authored by team members
   * (OWNER/MEMBER/COLLABORATOR/MAINTAIN). GitHub-only; requires an explicit
   * agent sandbox provider in the repo's effective env. Off by default.
   */
  syncTeamPrs?: boolean;
  /** Inline env overrides (highest precedence). */
  env: Record<string, string>;
  /**
   * `manual_only`: the repo is registered for manual CLI runs from a local
   * checkout only. The worker never clones, polls, routes to, or schedules
   * work for it.
   */
  manualOnly?: boolean;
}

/** Provider-neutral base configuration for one error-monitoring project. */
export interface ErrorMonitorConfigBase {
  /** Stable source name; namespaces dedupe and worker logs. */
  id: string;
  /** Adapter discriminator. */
  provider: string;
  enabled: boolean;
  /** Repository where fixes for this monitoring project are implemented. */
  repo: string;
  /** Optional owning team, used for credentials and task execution context. */
  team?: string;
  query?: string;
  intervalSeconds: number;
  minOccurrences: number;
  maxIssuesPerTick: number;
  /** Leave a best-effort provider comment after terminal runs. */
  commentOnAction: boolean;
  envFile?: string;
  env: Record<string, string>;
}

/** Sentry-specific source settings layered on the provider-neutral base. */
export interface SentryErrorMonitorConfig extends ErrorMonitorConfigBase {
  provider: "sentry";
  organization: string;
  project: string;
  baseUrl?: string;
}

/** Discriminated union extended by each supported monitoring adapter. */
export type ErrorMonitorConfig = SentryErrorMonitorConfig;

/** One routing rule from a `[[routing.rules]]` entry. Set criteria are AND-ed; list values match any-of. */
export interface RoutingRule {
  /** Name of the repo tasks matching this rule route to. */
  repo: string;
  /** Restrict the rule to tasks acquired by this team (multi-team workspaces). */
  team?: string;
  /** Tracker project key (e.g. Jira key prefix, Linear team key). */
  project?: string;
  /** Task must carry at least one of these components. */
  components: string[];
  /** Task must carry at least one of these labels. */
  labels: string[];
}

/** Worker-scoped settings from the `[worker]` table. */
export interface WorkerSettings {
  /**
   * Working windows (quiet hours) gating new-task pickup; null when the
   * `[worker.schedule]` table is absent or empty (pickup unrestricted).
   */
  schedule: WorkerScheduleConfig | null;
  /** Update a global CLI install while idle, then restart the worker. */
  autoUpdate: boolean;
}

/** Dashboard access settings from the `[dashboard]` table. */
export interface DashboardSettings {
  /** Explicitly trusted non-loopback origins (`allowed_origins`). */
  allowedOrigins: DashboardAllowedOrigin[];
  /** Trust names `tailscale serve` proxies to the dashboard (`tailscale_autodetect`, default true). */
  tailscaleAutodetect: boolean;
}

/** Parsed and validated `workspace.toml`. */
export interface WorkspaceConfig {
  workspace: WorkspaceSettings;
  dashboard: DashboardSettings;
  worker: WorkerSettings;
  defaults: WorkspaceDefaults;
  /** Team tracker sources; empty means the single `[defaults]` fleet query. */
  teams: TeamConfig[];
  repos: RepoConfig[];
  /** Error-monitoring projects, each explicitly mapped to a repo. */
  errorMonitors: ErrorMonitorConfig[];
  routing: RoutingRule[];
  automations: AutomationConfig[];
  estimations: EstimationConfig[];
  /**
   * Tracker project settings from `[trackers.<tracker>.projects.<key>]`
   * (status names, story-points field), in the `settings.json` shape.
   */
  trackerSettings?: import("../../types/settings").ProjectSettings;
}
