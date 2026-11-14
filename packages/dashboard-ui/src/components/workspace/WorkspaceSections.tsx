import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Inbox,
  ChevronRight,
  CircleCheck,
  ExternalLink,
  Braces,
  GitBranch,
  GitPullRequest,
  TriangleAlert,
} from "lucide-react";

import { AutomationGroupHeaderRow } from "@/components/AutomationGroupHeader";
import { SectionLink } from "@/components/workspace/SectionLink";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  WorkspaceAutomationView,
  WorkspaceConfigView,
  WorkspaceEnvFileView,
  WorkspaceErrorMonitorView,
  WorkspaceEstimationView,
  WorkspaceRepoView,
} from "@/lib/api";
import { groupAutomationsByRepo, showsGroupHeaders } from "@/lib/automation-groups";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import {
  collectEnvSources,
  conflictLabel,
  describeRemote,
  formatSeconds,
  promptPreview,
  scheduleLabel,
  trackerLabel,
  workingHoursLabel,
} from "@/components/workspace/workspace-model";
import type { EnvSource } from "@/components/workspace/workspace-model";

/** Hash route of one automation's detail page (mirrors `automationHash`). */
function automationHref(id: string): string {
  return `#/automations/${encodeURIComponent(id)}`;
}

/** Section wrapper: anchored heading, one-line purpose, content. */
export function WorkspaceSection({
  id,
  title,
  description,
  aside,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    // tabIndex=-1: the section rail moves focus here after scrolling.
    <section id={id} aria-labelledby={`${id}-title`} className="ws-section" tabIndex={-1}>
      <div className="ws-section-head">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="section-title">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 max-w-[72ch] text-[0.8125rem] text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Inline empty state for a section inside the page: same dashed language as
 * the shared `EmptyState`, at body size and about half its height.
 */
export function WorkspaceEmpty({
  title,
  body,
  icon: Icon = Inbox,
  action,
}: {
  title: string;
  body: ReactNode;
  icon?: typeof Inbox;
  action?: ReactNode;
}) {
  return (
    <div className="ws-empty">
      <span className="ws-empty-icon">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[0.8125rem] font-semibold">{title}</div>
        <div className="mt-0.5 max-w-[72ch] text-[0.8125rem] text-muted-foreground">{body}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Scroll-capped prompt with a bottom fade while more text is below. */
function PromptBody({ prompt }: { prompt: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setMore(element.scrollTop + element.clientHeight < element.scrollHeight - 4);
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, [prompt]);
  return (
    <div ref={ref} className="ws-prompt-body" data-more={more ? "true" : undefined}>
      <Markdown>{prompt}</Markdown>
    </div>
  );
}

/** Variable names as quiet monospace chips; long lists collapse behind "+N more". */
export function KeyChips({ keys, limit = 10 }: { keys: string[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (keys.length === 0) return <span className="text-xs text-subtle-foreground">No keys</span>;
  const shown = expanded ? keys : keys.slice(0, limit);
  const hidden = keys.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Variable names">
      {shown.map((key) => (
        <li key={key} className="ws-key">
          {key}
        </li>
      ))}
      {hidden > 0 || expanded ? (
        <li>
          <button
            type="button"
            className="ws-key ws-key-more"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {expanded ? "Show fewer" : `+${hidden} more`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function Chips({ values }: { values: string[] | undefined }) {
  if (!values || values.length === 0) return <Dash />;
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((value) => (
        <span key={value} className="ws-label">
          {value}
        </span>
      ))}
    </span>
  );
}

function Dash({ title }: { title?: string }) {
  return (
    <span className="text-subtle-foreground" title={title}>
      –
    </span>
  );
}

function EnabledText({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        enabled ? "text-muted-foreground" : "text-subtle-foreground",
      )}
    >
      <span
        className={cn("status-dot", enabled ? "text-success" : "text-neutral opacity-60")}
        aria-hidden="true"
      />
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

/** Env file path with an exists / missing marker. */
export function EnvFileStatus({ file }: { file: WorkspaceEnvFileView }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={file.resolvedPath}>
      {file.exists ? (
        <CircleCheck className="size-3.5 shrink-0 text-success" aria-label="File found" />
      ) : (
        <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-label="File missing" />
      )}
      <code className={cn("truncate font-mono text-xs", !file.exists && "text-warning")}>
        {file.path}
      </code>
      {!file.exists ? <span className="text-xs text-warning">missing</span> : null}
    </span>
  );
}

/* ---------- Repositories ---------- */

function RemoteLink({ remote }: { remote: string }) {
  const { label, href } = describeRemote(remote);
  if (!href) {
    return (
      <code className="font-mono text-xs text-muted-foreground" title={remote}>
        {label}
      </code>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ref-link text-xs" title={remote}>
      <span className="font-mono">{label}</span>
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

/** Repos in diagram order; repos missing from `order` (unrouted) go last. */
export function sortReposByOrder<T extends { name: string }>(repos: T[], order: string[]): T[] {
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return [...repos].sort((a, b) => rank(a.name) - rank(b.name));
}

export function ReposTable({
  repos,
  order = [],
  defaultPipeline,
}: {
  repos: WorkspaceRepoView[];
  order?: string[];
  defaultPipeline?: string;
}) {
  if (repos.length === 0) {
    return (
      <WorkspaceEmpty
        title="No repositories yet"
        body={
          <>
            Run <code className="font-mono text-xs">devintern worker add-repo</code> inside a
            checkout to register it, or add a <code className="font-mono text-xs">[[repos]]</code>{" "}
            entry with a name and remote.
          </>
        }
      />
    );
  }
  // "Remote default" on every row says nothing: drop the column unless one repo pins a branch.
  const showBranch = repos.some((repo) => Boolean(repo.defaultBranch));
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table className="ws-table">
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">Repository</TableHead>
            <TableHead className="hidden px-4 xl:table-cell">Remote</TableHead>
            {showBranch ? (
              <TableHead className="hidden px-4 xl:table-cell">Base branch</TableHead>
            ) : null}
            <TableHead className="px-4">PR labels</TableHead>
            <TableHead className="px-4">Pipeline</TableHead>
            <TableHead className="px-4">Env</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortReposByOrder(repos, order).map((repo) => {
            const envCount = (repo.envFile?.keys.length ?? 0) + repo.envKeys.length;
            return (
              <TableRow
                key={repo.name}
                id={`ws-repo-${repo.name}`}
                tabIndex={-1}
                className="ws-anchor-row"
              >
                <TableCell className="px-4">
                  <div className="font-medium">{repo.name}</div>
                  <div className="flex flex-wrap items-center gap-x-2 xl:hidden">
                    <RemoteLink remote={repo.remote} />
                    {repo.defaultBranch ? (
                      <span className="font-mono text-xs text-subtle-foreground">
                        {repo.defaultBranch}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="hidden px-4 xl:table-cell">
                  <RemoteLink remote={repo.remote} />
                </TableCell>
                {showBranch ? (
                  <TableCell className="hidden px-4 xl:table-cell">
                    {repo.defaultBranch ? (
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                        <GitBranch className="size-3.5 text-subtle-foreground" aria-hidden="true" />
                        {repo.defaultBranch}
                      </span>
                    ) : (
                      <span className="text-xs text-subtle-foreground">Remote default</span>
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="px-4">
                  <Chips values={repo.prLabels} />
                </TableCell>
                <TableCell className="px-4">
                  {repo.pipelineFile ? (
                    <code className="font-mono text-xs">{repo.pipelineFile}</code>
                  ) : defaultPipeline ? (
                    <span className="text-xs text-subtle-foreground" title={defaultPipeline}>
                      Workspace default
                    </span>
                  ) : (
                    <span className="text-xs text-subtle-foreground">Built-in</span>
                  )}
                </TableCell>
                <TableCell className="px-4">
                  {repo.envFile && !repo.envFile.exists ? (
                    <SectionLink
                      to="ws-credentials"
                      className="inline-flex items-center gap-1 text-xs text-warning"
                    >
                      <TriangleAlert className="size-3.5" aria-hidden="true" /> Env file missing
                    </SectionLink>
                  ) : envCount > 0 ? (
                    <SectionLink
                      to="ws-credentials"
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {envCount} {envCount === 1 ? "key" : "keys"}
                    </SectionLink>
                  ) : (
                    <span className="text-xs text-subtle-foreground">Shared only</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/* ---------- Schedules ---------- */

function ScheduleCell({ cron, interval }: { cron?: string; interval?: string }) {
  const { label, raw } = scheduleLabel({ cron, interval });
  return (
    <span
      className="flex flex-col leading-tight"
      title={raw ? `${cron ? "Cron" : "Interval"}: ${raw}` : undefined}
    >
      <span>{label}</span>
      {raw ? (
        <code className="mt-0.5 font-mono text-[0.6875rem] text-subtle-foreground">{raw}</code>
      ) : null}
    </span>
  );
}

function AutomationRows({
  automation,
  expanded,
  onToggle,
}: {
  automation: WorkspaceAutomationView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const panelId = `ws-prompt-${automation.id}`;
  const agent = agentSummary(automation);
  return (
    <>
      <TableRow
        className={cn("ws-auto-row", !automation.enabled && "ws-row-disabled")}
        data-state={expanded ? "selected" : undefined}
      >
        <TableCell className="w-8 py-2 pr-0 pl-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={`${expanded ? "Hide" : "Show"} prompt for ${automation.id}`}
            onClick={onToggle}
          >
            <ChevronRight className={cn("ws-chevron", expanded && "rotate-90")} />
          </Button>
        </TableCell>
        <TableCell className="ws-cell-name px-3 whitespace-normal">
          <a href={automationHref(automation.id)} className="font-medium hover:underline">
            {automation.id}
          </a>
          {expanded ? null : (
            <button
              type="button"
              className="ws-prompt-preview"
              onClick={onToggle}
              tabIndex={-1}
              title="Show the full prompt"
            >
              {promptPreview(automation.prompt)}
            </button>
          )}
        </TableCell>
        <TableCell className="px-4">
          <ScheduleCell cron={automation.cron} interval={automation.interval} />
        </TableCell>
        <TableCell className="px-4">
          {automation.openPr ? (
            <span className="inline-flex items-center gap-1.5 text-xs">
              <GitPullRequest className="size-3.5 text-subtle-foreground" aria-hidden="true" />
              Opens PR
            </span>
          ) : (
            <span className="text-xs text-subtle-foreground">No PR</span>
          )}
        </TableCell>
        <TableCell className="px-4">
          <EnabledText enabled={automation.enabled} />
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="ws-prompt-row hover:bg-transparent">
          <TableCell
            colSpan={AUTOMATION_COLUMNS}
            className="px-4 pt-1 pb-4 whitespace-normal"
            id={panelId}
          >
            <div className="ws-prompt">
              <div className="ws-prompt-meta">
                <span>Prompt</span>
                {automation.allowNoChanges ? <span>May finish without changes</span> : null}
                {agent ? <span>Agent: {agent}</span> : null}
                <a href={automationHref(automation.id)} className="ref-link ml-auto">
                  Open automation <ChevronRight className="size-3" aria-hidden="true" />
                </a>
              </div>
              <PromptBody prompt={automation.prompt.trim()} />
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

/** Columns in the workspace automations table (for full-width rows). */
const AUTOMATION_COLUMNS = 5;

/** "claude-code · opus · medium effort" for an entry's agent override, if any. */
function agentSummary(automation: WorkspaceAutomationView): string | undefined {
  const parts = [
    automation.harness,
    automation.model,
    automation.effort ? `${automation.effort} effort` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Workspace automations grouped by target repository (general first, then
 * repos by name), one `<tbody>` per group under a header row.
 */
export function AutomationsTable({ automations }: { automations: WorkspaceAutomationView[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const groups = groupAutomationsByRepo(automations);
  const grouped = showsGroupHeaders(groups);
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table className="ws-table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8 pr-0 pl-2">
              <span className="sr-only">Prompt</span>
            </TableHead>
            <TableHead className="px-3">Automation</TableHead>
            <TableHead className="px-4">Schedule</TableHead>
            <TableHead className="px-4">Output</TableHead>
            <TableHead className="px-4">Status</TableHead>
          </TableRow>
        </TableHeader>
        {groups.map((group) => (
          <TableBody key={group.key} className="auto-group">
            {grouped ? (
              <AutomationGroupHeaderRow group={group} colSpan={AUTOMATION_COLUMNS} level={3} />
            ) : null}
            {group.automations.map((automation) => (
              <AutomationRows
                key={automation.id}
                automation={automation}
                expanded={open.has(automation.id)}
                onToggle={() => toggle(automation.id)}
              />
            ))}
          </TableBody>
        ))}
      </Table>
    </div>
  );
}

export function EstimationsTable({
  estimations,
  tracker,
}: {
  estimations: WorkspaceEstimationView[];
  tracker: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table className="ws-table">
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">Estimation</TableHead>
            <TableHead className="px-4">Schedule</TableHead>
            <TableHead className="px-4">{trackerLabel(tracker)} query</TableHead>
            <TableHead className="px-4">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {estimations.map((estimation) => (
            <TableRow key={estimation.id} className={cn(!estimation.enabled && "ws-row-disabled")}>
              <TableCell className="px-4 font-medium">{estimation.id}</TableCell>
              <TableCell className="px-4">
                <ScheduleCell cron={estimation.cron} interval={estimation.interval} />
              </TableCell>
              <TableCell className="px-4 whitespace-normal">
                <code className="font-mono text-xs text-muted-foreground">{estimation.query}</code>
              </TableCell>
              <TableCell className="px-4">
                <EnabledText enabled={estimation.enabled} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ---------- Error monitors ---------- */

export function MonitorsTable({ monitors }: { monitors: WorkspaceErrorMonitorView[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table className="ws-table">
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">Monitor</TableHead>
            <TableHead className="px-4">Project</TableHead>
            <TableHead className="px-4">Repository</TableHead>
            <TableHead className="px-4">Cadence</TableHead>
            <TableHead className="px-4">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {monitors.map((monitor) => (
            <TableRow key={monitor.id} className={cn(!monitor.enabled && "ws-row-disabled")}>
              <TableCell className="px-4 whitespace-normal">
                <div className="font-medium">{monitor.id}</div>
                {monitor.query ? (
                  <code className="font-mono text-xs text-subtle-foreground">{monitor.query}</code>
                ) : null}
              </TableCell>
              <TableCell className="px-4">
                <div>
                  {trackerLabel(monitor.provider)}{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    {monitor.organization}/{monitor.project}
                  </span>
                </div>
                {monitor.baseUrl ? (
                  <div className="font-mono text-xs text-subtle-foreground">{monitor.baseUrl}</div>
                ) : null}
              </TableCell>
              <TableCell className="px-4">
                <div>{monitor.repo}</div>
                {monitor.team ? (
                  <div className="text-xs text-subtle-foreground">team {monitor.team}</div>
                ) : null}
              </TableCell>
              <TableCell className="px-4 whitespace-normal">
                <div>Every {formatSeconds(monitor.intervalSeconds)}</div>
                <div className="text-xs text-subtle-foreground">
                  ≥ {monitor.minOccurrences} {monitor.minOccurrences === 1 ? "event" : "events"} ·
                  up to {monitor.maxIssuesPerTick} per check
                  {monitor.commentOnAction ? " · comments on the issue" : ""}
                </div>
              </TableCell>
              <TableCell className="px-4">
                <EnabledText enabled={monitor.enabled} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ---------- Credentials ---------- */

const SCOPE_KIND: Record<EnvSource["kind"], string> = {
  shared: "Shared",
  team: "Team",
  repo: "Repo",
  monitor: "Monitor",
};

export function CredentialsList({ config }: { config: WorkspaceConfigView }) {
  const sources = collectEnvSources(config);
  return (
    <ul className="ws-env-list">
      {sources.map((source) => {
        const missing = source.file !== undefined && !source.file.exists;
        return (
          <li key={source.id} className={cn("ws-env", missing && "ws-env-missing")}>
            <div className="ws-env-scope">
              <span className="text-xs text-subtle-foreground">{SCOPE_KIND[source.kind]}</span>
              <span className="truncate font-medium" title={source.scope}>
                {source.kind === "shared" ? ".env" : source.scope}
              </span>
            </div>
            <div className="ws-env-detail">
              {source.file ? (
                <div className="space-y-1.5">
                  <EnvFileStatus file={source.file} />
                  <div className="ws-env-indent">
                    {source.file.exists ? (
                      <KeyChips keys={source.file.keys} />
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {source.kind === "shared"
                          ? "No shared .env; every key must come from a team, repo, or the worker's environment."
                          : "The worker cannot read this file, so keys it should provide are unset for this source."}
                      </p>
                    )}
                  </div>
                </div>
              ) : null}
              {source.inlineKeys.length > 0 ? (
                <div className="space-y-1.5">
                  <span className="inline-flex items-center gap-1.5 text-xs text-subtle-foreground">
                    <Braces className="size-3.5 shrink-0" aria-hidden="true" />
                    Inline in workspace.toml
                  </span>
                  <div className="ws-env-indent">
                    <KeyChips keys={source.inlineKeys} />
                  </div>
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- Execution & policy ---------- */

function Setting({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="ws-setting">
      <dt>{label}</dt>
      <dd>
        {children}
        {hint ? <span className="block text-xs text-subtle-foreground">{hint}</span> : null}
      </dd>
    </div>
  );
}

function OnOff({
  on,
  onLabel = "On",
  offLabel = "Off",
}: {
  on: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return on ? <span>{onLabel}</span> : <span className="text-subtle-foreground">{offLabel}</span>;
}

export function ExecutionSettings({ config }: { config: WorkspaceConfigView }) {
  const { workspace, worker, defaults } = config;
  const hours = workingHoursLabel(worker.schedule);
  const groups: { title: string; settings: ReactNode }[] = [
    {
      title: "Concurrency",
      settings: (
        <>
          <Setting label="Isolation">
            {workspace.execution.isolation === "best_effort_host" ? (
              "Best-effort host"
            ) : (
              <span className="text-subtle-foreground">Not set</span>
            )}
          </Setting>
          <Setting label="Max agent jobs">
            <span className="tabular">{workspace.execution.maxConcurrency}</span>
          </Setting>
          <Setting label="Per repository">
            <span className="tabular">{workspace.execution.maxConcurrencyPerRepo}</span>
          </Setting>
        </>
      ),
    },
    {
      title: "Task pickup",
      settings: (
        <>
          <Setting label="Poll interval">
            Every {formatSeconds(defaults.pollIntervalSeconds)}
          </Setting>
          <Setting label="Working hours" hint={hours.detail}>
            {hours.label}
          </Setting>
          <Setting label="Task args">
            {defaults.workerTaskArgs ? (
              <code className="font-mono text-xs">{defaults.workerTaskArgs}</code>
            ) : (
              <Dash />
            )}
          </Setting>
        </>
      ),
    },
    {
      title: "Pull requests",
      settings: (
        <>
          <Setting label="Default labels">
            <Chips values={defaults.prLabels} />
          </Setting>
          <Setting label="Pipeline">
            {defaults.pipelineFile ? (
              <code className="font-mono text-xs">{defaults.pipelineFile}</code>
            ) : (
              <span className="text-subtle-foreground">Built-in</span>
            )}
          </Setting>
          <Setting label="Fix CI failures">
            <OnOff on={workspace.ciFailureFix} />
          </Setting>
        </>
      ),
    },
    {
      title: "Maintenance",
      settings: (
        <>
          <Setting
            label="Conflicts"
            hint={
              workspace.conflictSchedule?.cron ? (
                <code className="font-mono">{workspace.conflictSchedule.cron}</code>
              ) : undefined
            }
          >
            {conflictLabel(workspace.conflictResolution, workspace.conflictSchedule)}
          </Setting>
          <Setting label="Worktree TTL">
            {workspace.worktreesTtlDays} {workspace.worktreesTtlDays === 1 ? "day" : "days"}
          </Setting>
          <Setting label="Auto-update">
            <OnOff on={worker.autoUpdate} />
          </Setting>
          <Setting label="Dashboard">
            <OnOff
              on={workspace.dashboard}
              onLabel={workspace.dashboardPort ? `On · port ${workspace.dashboardPort}` : "On"}
            />
          </Setting>
        </>
      ),
    },
  ];
  return (
    <div className="ws-settings">
      {groups.map((group) => (
        <Fragment key={group.title}>
          <div className="ws-settings-group">
            <h3 className="ws-settings-title">{group.title}</h3>
            <dl>{group.settings}</dl>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
