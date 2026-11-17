/**
 * Pure view-model helpers for the Workspace screen: how work flows from
 * sources (tracker teams, schedules, error monitors) through routing into
 * repositories, plus the human labels the screen shows for config values.
 *
 * The routing semantics mirror `packages/code/src/lib/workspace/router.ts`:
 * a team with a fixed `repo` bypasses rules; otherwise rules scoped to the
 * team and unscoped rules apply; a one-repo workspace needs no rules.
 */

import type {
  WorkspaceConfigView,
  WorkspaceEnvFileView,
  WorkspaceRoutingRule,
  WorkspaceScheduleView,
} from "@/lib/api";
import { humanizeSchedule } from "@/views/automation-schedule";

/** How one source's work reaches a repo. */
export type FlowRoute =
  | { kind: "fixed"; repo: string; known: boolean }
  | { kind: "rule"; repo: string; known: boolean; criteria: string[]; scoped: boolean }
  | { kind: "only"; repo: string; known: true }
  | { kind: "unrouted" };

export type FlowSourceKind = "team" | "defaults" | "automations" | "monitor";

export interface FlowSource {
  /** Stable key, unique across sources. */
  id: string;
  kind: FlowSourceKind;
  title: string;
  /** Tracker / provider label ("Jira", "GitHub", "Sentry", "Schedule"). */
  badge: string;
  /** Query or other one-line description, shown in monospace. */
  query?: string;
  /** Secondary line (e.g. "2 disabled"). */
  note?: string;
  routes: FlowRoute[];
  /** An env file this source reads is missing. */
  envMissing: boolean;
  /** The whole source is switched off. */
  disabled: boolean;
  /** What happens to a task no rule routes (rule-routed sources only). */
  fallthrough?: FlowFallthrough;
}

/**
 * Where a rule-routed task goes when no rule (or rules for several repos)
 * match, per the worker's `routeTaskWithRules`: a one-repo workspace falls
 * back to its only repo; otherwise the task is skipped and recorded.
 */
export type FlowFallthrough = { kind: "skipped" } | { kind: "repo"; repo: string };

export interface FlowRepo {
  name: string;
  remote: string;
  /** Sources that land work here. */
  inbound: number;
}

export interface WorkspaceFlow {
  sources: FlowSource[];
  /** Repos ordered by first inbound appearance (fewer crossing lines), idle repos last. */
  repos: FlowRepo[];
}

const TRACKER_LABELS: Record<string, string> = {
  jira: "Jira",
  github: "GitHub",
  linear: "Linear",
  trello: "Trello",
  asana: "Asana",
  "azure-devops": "Azure DevOps",
  gitlab: "GitLab",
  markdown: "Markdown",
  sentry: "Sentry",
};

/** Display name for a tracker or provider kind. */
export function trackerLabel(kind: string): string {
  return TRACKER_LABELS[kind.toLowerCase()] ?? kind;
}

/** Human criteria of a routing rule: `project DEV`, `labels a, b`, `components api`. */
export function ruleCriteria(rule: WorkspaceRoutingRule): string[] {
  const criteria: string[] = [];
  if (rule.project) criteria.push(`project ${rule.project}`);
  if (rule.labels.length > 0) {
    criteria.push(`${rule.labels.length === 1 ? "label" : "labels"} ${rule.labels.join(", ")}`);
  }
  if (rule.components.length > 0) {
    criteria.push(
      `${rule.components.length === 1 ? "component" : "components"} ${rule.components.join(", ")}`,
    );
  }
  return criteria.length > 0 ? criteria : ["any task"];
}

function sameName(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Rules that apply to a team (team-scoped or unscoped), per `effectiveRoutingRules`. */
function rulesFor(routing: WorkspaceRoutingRule[], team?: string): WorkspaceRoutingRule[] {
  if (!team) return routing;
  return routing.filter((rule) => !rule.team || sameName(rule.team, team));
}

/** Fallthrough for a source that routes by rules; none when it has no rules at all. */
function fallthroughFor(
  config: WorkspaceConfigView,
  team: string | undefined,
): FlowFallthrough | undefined {
  if (rulesFor(config.routing, team).length === 0) return undefined;
  const onlyRepo = config.repos.length === 1 ? config.repos[0]?.name : undefined;
  return onlyRepo ? { kind: "repo", repo: onlyRepo } : { kind: "skipped" };
}

function routesFor(
  config: WorkspaceConfigView,
  fixedRepo: string | undefined,
  team: string | undefined,
): FlowRoute[] {
  const known = (repo: string) => config.repos.some((candidate) => candidate.name === repo);
  if (fixedRepo) return [{ kind: "fixed", repo: fixedRepo, known: known(fixedRepo) }];
  const rules = rulesFor(config.routing, team);
  const routes: FlowRoute[] = rules.map((rule) => ({
    kind: "rule",
    repo: rule.repo,
    known: known(rule.repo),
    criteria: ruleCriteria(rule),
    scoped: Boolean(rule.team),
  }));
  const onlyRepo = config.repos.length === 1 ? config.repos[0] : undefined;
  if (routes.length === 0 && onlyRepo) {
    return [{ kind: "only", repo: onlyRepo.name, known: true }];
  }
  return routes.length > 0 ? routes : [{ kind: "unrouted" }];
}

function hasMissingEnv(file: WorkspaceEnvFileView | undefined): boolean {
  return file !== undefined && !file.exists;
}

/**
 * Build the sources → routing → repos graph. Tracker teams come first (or
 * the single `[defaults]` poller when no teams exist), then automations
 * grouped by destination repo, then error monitors.
 */
export function buildWorkspaceFlow(config: WorkspaceConfigView): WorkspaceFlow {
  const sources: FlowSource[] = [];

  if (config.teams.length > 0) {
    for (const team of config.teams) {
      sources.push({
        id: `team:${team.name}`,
        kind: "team",
        title: team.name,
        badge: trackerLabel(team.tracker),
        query: team.taskQuery,
        routes: routesFor(config, team.repo, team.name),
        envMissing: hasMissingEnv(team.envFile),
        disabled: false,
        fallthrough: team.repo ? undefined : fallthroughFor(config, team.name),
      });
    }
  } else if (config.defaults.taskQuery || config.repos.length > 0) {
    sources.push({
      id: "defaults",
      kind: "defaults",
      title: "Default poller",
      badge: trackerLabel(config.defaults.tracker),
      query: config.defaults.taskQuery,
      routes: routesFor(config, undefined, undefined),
      envMissing: false,
      disabled: false,
      fallthrough: fallthroughFor(config, undefined),
    });
  }

  const onlyRepo = config.repos.length === 1 ? config.repos[0]?.name : undefined;
  // One row per destination repo, with disabled automations in their own
  // dimmed row so the diagram matches the table's enabled/disabled split.
  const automationGroups = new Map<string, { repo: string; enabled: boolean; count: number }>();
  for (const automation of config.automations) {
    const repo = automation.repo ?? onlyRepo ?? "";
    const key = `${repo}:${automation.enabled ? "on" : "off"}`;
    const group = automationGroups.get(key) ?? { repo, enabled: automation.enabled, count: 0 };
    group.count += 1;
    automationGroups.set(key, group);
  }
  const groups = [...automationGroups.values()].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled),
  );
  for (const group of groups) {
    const noun = group.count === 1 ? "automation" : "automations";
    sources.push({
      id: `automations:${group.repo}:${group.enabled ? "on" : "off"}`,
      kind: "automations",
      title: group.enabled ? `${group.count} ${noun}` : `${group.count} disabled ${noun}`,
      badge: "Schedule",
      routes: group.repo
        ? [
            {
              kind: "fixed",
              repo: group.repo,
              known: config.repos.some((candidate) => candidate.name === group.repo),
            },
          ]
        : [{ kind: "unrouted" }],
      envMissing: false,
      disabled: !group.enabled,
    });
  }

  for (const monitor of config.errorMonitors) {
    sources.push({
      id: `monitor:${monitor.id}`,
      kind: "monitor",
      title: monitor.id,
      badge: trackerLabel(monitor.provider),
      query: monitor.query,
      note: `project ${monitor.organization}/${monitor.project}`,
      routes: [
        {
          kind: "fixed",
          repo: monitor.repo,
          known: config.repos.some((candidate) => candidate.name === monitor.repo),
        },
      ],
      envMissing: hasMissingEnv(monitor.envFile),
      disabled: !monitor.enabled,
    });
  }

  return { sources, repos: orderFlowRepos(config, sources) };
}

/** One wire's vertical position on the source side: row index plus its chip's slot in the row. */
function wireRows(sources: FlowSource[]): { row: number; repo: string }[] {
  const wires: { row: number; repo: string }[] = [];
  sources.forEach((source, index) => {
    const routes = source.routes.flatMap((route) => (route.kind === "unrouted" ? [] : [route]));
    routes.forEach((route, slot) => {
      wires.push({ row: index + (slot + 0.5) / routes.length, repo: route.repo });
    });
  });
  return wires;
}

/**
 * Count wire crossings for a repo order (top to bottom). Two wires cross when
 * their source rows and repo positions disagree on order.
 */
export function countFlowCrossings(sources: FlowSource[], repoOrder: string[]): number {
  const position = new Map(repoOrder.map((name, index) => [name, index]));
  const wires = wireRows(sources).filter((wire) => position.has(wire.repo));
  let crossings = 0;
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const a = wires[i]!;
      const b = wires[j]!;
      const pa = position.get(a.repo)!;
      const pb = position.get(b.repo)!;
      if (pa !== pb && (a.row - b.row) * (pa - pb) < 0) crossings++;
    }
  }
  return crossings;
}

/**
 * Order repos to keep wires from crossing: start from the barycenter (mean
 * source-row index per repo, ties by first appearance), then swap adjacent
 * repos while that lowers the crossing count. Deterministic; repos without
 * inbound routes go last in config order.
 */
export function orderFlowRepos(config: WorkspaceConfigView, sources: FlowSource[]): FlowRepo[] {
  const rows = new Map<string, number[]>();
  sources.forEach((source, index) => {
    for (const route of source.routes) {
      if (route.kind === "unrouted") continue;
      rows.set(route.repo, [...(rows.get(route.repo) ?? []), index]);
    }
  });
  const weight = (name: string): number => {
    const indexes = rows.get(name);
    if (!indexes) return Infinity;
    return indexes.reduce((sum, index) => sum + index, 0) / indexes.length;
  };
  const first = (name: string): number => rows.get(name)?.[0] ?? Infinity;
  const ordered = [...config.repos].sort((a, b) => {
    const wa = weight(a.name);
    const wb = weight(b.name);
    if (wa === wb) return first(a.name) - first(b.name);
    return wa - wb;
  });
  const fed = ordered.filter((repo) => rows.has(repo.name));
  const idle = ordered.filter((repo) => !rows.has(repo.name));
  const names = fed.map((repo) => repo.name);
  let best = countFlowCrossings(sources, names);
  for (let improved = true; improved && best > 0; ) {
    improved = false;
    for (let i = 0; i < names.length - 1; i++) {
      [names[i], names[i + 1]] = [names[i + 1]!, names[i]!];
      const count = countFlowCrossings(sources, names);
      if (count < best) {
        best = count;
        improved = true;
      } else {
        [names[i], names[i + 1]] = [names[i + 1]!, names[i]!];
      }
    }
  }
  const byName = new Map(config.repos.map((repo) => [repo.name, repo]));
  return [...names.map((name) => byName.get(name)!), ...idle].map((repo) => ({
    name: repo.name,
    remote: repo.remote,
    inbound: rows.get(repo.name)?.length ?? 0,
  }));
}

/** What a fixed route carries, by source kind ("all tasks", "every run", …). */
function fixedLabel(kind: FlowSourceKind | undefined, disabled = false): string {
  if (disabled) return "paused";
  if (kind === "automations") return "every run";
  if (kind === "monitor") return "every issue";
  return "all tasks";
}

/** Short label for a route chip, e.g. "all tasks" or "project DEV". */
export function routeLabel(route: FlowRoute, kind?: FlowSourceKind, disabled = false): string {
  switch (route.kind) {
    case "fixed":
    case "only":
      return fixedLabel(kind, disabled);
    case "rule":
      return route.criteria.join(" · ");
    case "unrouted":
      return "No route";
  }
}

/** Plain-text reading of the diagram for screen readers (`aria-describedby`). */
export function describeFlow(flow: WorkspaceFlow): string {
  const sentences = flow.sources.map((source) => {
    const subject =
      source.kind === "automations" ? source.title : `${source.title} (${source.badge})`;
    const prefix =
      source.disabled && source.kind !== "automations" ? `${subject}, disabled,` : subject;
    const routes = source.routes.map((route) => {
      if (route.kind === "unrouted") return "has no route, so its tasks are skipped";
      const target = `${route.repo}${route.known ? "" : " (not a configured repo)"}`;
      return source.disabled && route.kind !== "rule"
        ? `is paused (targets ${target})`
        : `sends ${routeLabel(route, source.kind)} to ${target}`;
    });
    const otherwise =
      source.fallthrough?.kind === "skipped"
        ? "; otherwise its tasks are skipped"
        : source.fallthrough?.kind === "repo"
          ? `; otherwise to ${source.fallthrough.repo}`
          : "";
    return `${prefix} ${routes.join("; ")}${otherwise}.`;
  });
  const idle = flow.repos.filter((repo) => repo.inbound === 0).map((repo) => repo.name);
  if (idle.length > 0) {
    sentences.push(
      `${idle.join(", ")} ${idle.length === 1 ? "receives" : "receive"} no routed work, only ad-hoc tasks.`,
    );
  }
  return sentences.join(" ");
}

/** Primary and raw text of a cron-or-interval schedule. */
export function scheduleLabel(schedule: WorkspaceScheduleView | undefined): {
  label: string;
  raw?: string;
} {
  const raw = schedule?.cron ?? schedule?.interval;
  if (!raw) return { label: "–" };
  const human = humanizeSchedule(raw);
  if (!human) return { label: raw };
  // An interval ("12h") says nothing "Every 12h" doesn't; a cron does.
  return schedule?.cron ? { label: human, raw } : { label: human };
}

/** "Every 60s" / "Every 5m" / "Every 2h" for a poll cadence in seconds. */
export function formatSeconds(seconds: number): string {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Owner/repo label plus a browsable URL for common git remotes. */
export function describeRemote(remote: string): { label: string; href?: string } {
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(remote);
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(
    remote,
  );
  const match = scp ?? url;
  if (!match) return { label: remote };
  const host = match[1] ?? "";
  const path = match[2] ?? "";
  const label = host === "github.com" ? path : `${host}/${path}`;
  const browsable = /^(github\.com|gitlab\.com|bitbucket\.org)$/.test(host);
  return { label, href: browsable ? `https://${host}/${path}` : undefined };
}

export type ConflictMode = WorkspaceConfigView["workspace"]["conflictResolution"];

/** Human conflict-resolution policy, including its schedule when scheduled. */
export function conflictLabel(
  mode: ConflictMode,
  schedule: WorkspaceScheduleView | undefined,
): string {
  if (mode === "auto") return "Automatic";
  if (mode === "disabled") return "Off";
  const { label } = scheduleLabel(schedule);
  return label === "–" ? "Scheduled" : `Scheduled · ${label}`;
}

/** Worker pickup hours, e.g. "Any time" or "22:00–06:00 (Europe/Berlin)". */
export function workingHoursLabel(schedule: WorkspaceConfigView["worker"]["schedule"]): {
  label: string;
  detail?: string;
} {
  if (!schedule) return { label: "Any time" };
  const fmt = (spec: string) => spec.replace(/\s*-\s*/, "–");
  const label =
    schedule.active.length > 0
      ? schedule.active.map((window) => fmt(window.spec)).join(", ")
      : "Any time";
  const detail = [
    schedule.blocked.length > 0
      ? `paused ${schedule.blocked.map((window) => fmt(window.spec)).join(", ")}`
      : undefined,
    schedule.timezone,
    schedule.catchUpMissed ? "catches up missed windows" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return { label, detail: detail || undefined };
}

/** One env source shown in the credentials section. */
export interface EnvSource {
  id: string;
  scope: string;
  /** Owner kind, for the scope label. */
  kind: "shared" | "team" | "repo" | "monitor";
  file?: WorkspaceEnvFileView;
  inlineKeys: string[];
}

/** Every env source in config order: shared `.env`, teams, repos, monitors. */
export function collectEnvSources(config: WorkspaceConfigView): EnvSource[] {
  const sources: EnvSource[] = [
    { id: "shared", scope: "Workspace", kind: "shared", file: config.sharedEnv, inlineKeys: [] },
  ];
  const push = (
    kind: EnvSource["kind"],
    name: string,
    file: WorkspaceEnvFileView | undefined,
    inlineKeys: string[],
  ) => {
    if (file || inlineKeys.length > 0) {
      sources.push({ id: `${kind}:${name}`, scope: name, kind, file, inlineKeys });
    }
  };
  for (const team of config.teams) push("team", team.name, team.envFile, team.envKeys);
  for (const repo of config.repos) push("repo", repo.name, repo.envFile, repo.envKeys);
  for (const monitor of config.errorMonitors) {
    push("monitor", monitor.id, monitor.envFile, monitor.envKeys);
  }
  return sources;
}

/** Something on the page the user should look at. */
export interface WorkspaceIssue {
  id: string;
  message: string;
  /** In-page anchor of the section that shows it. */
  anchor: string;
}

/** Warnings derived from the config: missing env files, unrouted sources, unknown repos. */
export function collectIssues(config: WorkspaceConfigView, flow: WorkspaceFlow): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];
  for (const env of collectEnvSources(config)) {
    if (env.file && !env.file.exists) {
      // A missing shared .env is normal for a workspace that keeps keys elsewhere.
      if (env.kind === "shared") continue;
      issues.push({
        id: `env:${env.id}`,
        message: `${env.scope}: env file ${env.file.path} is missing`,
        anchor: "ws-credentials",
      });
    }
  }
  for (const source of flow.sources) {
    if (source.kind === "automations") continue;
    for (const route of source.routes) {
      if (route.kind === "unrouted") {
        issues.push({
          id: `unrouted:${source.id}`,
          message: `${source.title}: no routing rule or repo, so its tasks are skipped`,
          anchor: "ws-flow",
        });
      } else if (!route.known) {
        issues.push({
          id: `unknown:${source.id}:${route.repo}`,
          message: `${source.title}: routes to "${route.repo}", which is not a configured repo`,
          anchor: "ws-flow",
        });
      }
    }
  }
  // Automations are grouped in the diagram, so name each one here.
  const repoNames = new Set(config.repos.map((repo) => repo.name));
  for (const automation of config.automations) {
    if (automation.repo && !repoNames.has(automation.repo)) {
      issues.push({
        id: `unknown:automation:${automation.id}`,
        message: `Automation ${automation.id}: runs in "${automation.repo}", which is not a configured repo`,
        anchor: "ws-automations",
      });
    }
  }
  return issues;
}

/** First non-empty prompt line as plain text (markdown markers stripped) for a one-line preview. */
export function promptPreview(prompt: string): string {
  const line = prompt.split("\n").find((candidate) => candidate.trim()) ?? "";
  return line
    .trim()
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "")
    .replace(/[`*_]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}
