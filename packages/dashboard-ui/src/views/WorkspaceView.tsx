import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  BookOpen,
  CircleCheck,
  FileCog,
  FileQuestion,
  FileWarning,
  Info,
  RefreshCcw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";

import { EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { SectionLink } from "@/components/workspace/SectionLink";
import { WorkspaceFlowDiagram } from "@/components/workspace/WorkspaceFlow";
import {
  AutomationsTable,
  CredentialsList,
  EstimationsTable,
  ExecutionSettings,
  MonitorsTable,
  ReposTable,
  WorkspaceEmpty,
  WorkspaceSection,
} from "@/components/workspace/WorkspaceSections";
import {
  buildWorkspaceFlow,
  collectEnvSources,
  collectIssues,
} from "@/components/workspace/workspace-model";
import { usePoll, WORKSPACE_URL } from "@/lib/api";
import type { WorkspaceConfigView, WorkspaceResponse } from "@/lib/api";
import { cn, formatAge, formatTime } from "@/lib/utils";
// oxlint-disable-next-line import/no-unassigned-import -- view styles
import "./workspace.css";

export const WORKSPACE_DOCS_URL = "https://devintern.com/docs/code/workspaces";

function DocsButton({ label = "Workspace guide" }: { label?: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={WORKSPACE_DOCS_URL} target="_blank" rel="noreferrer">
        <BookOpen /> {label}
      </a>
    </Button>
  );
}

/** Config path, file age, and worker start: the provenance of everything below. */
function MetaBar({ response }: { response: WorkspaceResponse }) {
  return (
    <div className="space-y-1.5">
      <MetaRow response={response} />
      {response.configSync === "unconfirmed" ? (
        <p className="ws-meta-note">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Can&rsquo;t confirm the worker applied this version: it predates reload tracking, and
            the file changed after it started. Restarting the worker makes it certain.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function MetaRow({ response }: { response: WorkspaceResponse }) {
  return (
    <div className="ws-meta">
      <span className="inline-flex min-w-0 items-center gap-2">
        <FileCog className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
        <code
          className="truncate font-mono text-[0.8125rem] text-foreground"
          title={response.configPath}
        >
          {response.configPath}
        </code>
      </span>
      {response.fileModifiedAt ? (
        <span title={formatTime(response.fileModifiedAt)}>
          Modified {formatAge(response.fileModifiedAt)} ago
        </span>
      ) : null}
      <span title={response.workerStartedAt ? formatTime(response.workerStartedAt) : undefined}>
        {response.workerStartedAt
          ? `Worker started ${formatAge(response.workerStartedAt)} ago`
          : "No running worker"}
      </span>
      {response.configSync === "applied" ? (
        <span
          className="inline-flex items-center gap-1.5"
          title={
            response.appliedConfig
              ? `Applied ${formatTime(response.appliedConfig.appliedAt)}`
              : "Unchanged since the worker started"
          }
        >
          <CircleCheck className="size-3.5 text-success" aria-hidden="true" />
          Worker is running this version
        </span>
      ) : null}
    </div>
  );
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "warning" | "danger" | "info";
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("ws-callout", `ws-callout-${tone}`)}
    >
      <span className="ws-callout-icon">{icon}</span>
      <div className="min-w-0">
        <div className="font-medium text-foreground">{title}</div>
        {children ? (
          <div className="mt-1 text-[0.8125rem] text-muted-foreground">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

/** Settings a reload refuses; a save touching any of them applies nothing until restart. */
export const STARTUP_ONLY_KEYS: { key: string; detail?: string }[] = [
  { key: "[defaults].tracker" },
  { key: "[[teams]]", detail: "name, tracker, env_file, inline env, or adding/removing a team" },
  { key: "[[error_monitors]]", detail: "any change" },
  { key: "[workspace].dashboard", detail: "and dashboard_port" },
  { key: "[worker.schedule]" },
];

function StartupOnlyKeys() {
  return (
    <ul className="ws-startup-keys">
      {STARTUP_ONLY_KEYS.map((entry) => (
        <li key={entry.key}>
          <code>{entry.key}</code>
          {entry.detail ? <span> {entry.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Whether the worker runs the file on disk: only shown when it does not (or might not). */
function ConfigSyncNotice({ response }: { response: WorkspaceResponse }) {
  if (response.configSync === "rejected") {
    const applied = response.appliedConfig;
    const reason = applied?.rejectedReason;
    // Only a startup-only change is explained by the key list; any other reason stands alone.
    const startupOnly = !reason || /startup-only/i.test(reason);
    return (
      <Callout
        tone="warning"
        icon={<RotateCw className="size-4" aria-hidden="true" />}
        title={
          applied
            ? `The worker rejected the latest save and still runs the version from ${formatAge(applied.fileModifiedAt)} ago`
            : "The worker rejected the latest save and still runs its previous config"
        }
      >
        {reason ? <pre className="ws-reason">{reason}</pre> : null}
        {startupOnly ? (
          <>
            <p className="mt-2">
              A reload is all-or-nothing. When a save changes a startup-only setting, none of its
              edits apply, routing and automations included, until you restart the worker or revert
              that setting. Everything else reloads live, including a team&apos;s task_query and
              repo. Startup-only:
            </p>
            <StartupOnlyKeys />
          </>
        ) : (
          <p className="mt-2">
            Fix the error in workspace.toml and save again; the worker keeps running the last valid
            config.
          </p>
        )}
      </Callout>
    );
  }
  if (response.configSync === "pending") {
    return (
      <Callout
        tone="info"
        icon={<Info className="size-4" aria-hidden="true" />}
        title="The worker hasn't applied the latest save yet"
      >
        It reloads within a second of a save. If this stays, its file watcher may be down: send the
        worker SIGHUP or restart it.
      </Callout>
    );
  }
  return null;
}

interface NavItem {
  id: string;
  label: string;
  count?: number;
}

/** In-page section links: a sticky rail on wide screens, a wrapped row otherwise. */
function SectionNav({ items }: { items: NavItem[] }) {
  const [active, setActive] = useState(items[0]?.id);
  const ids = items.map((item) => item.id).join(" ");
  useEffect(() => {
    const sectionIds = ids.split(" ");
    // Active = the last section whose top has passed the upper third of the viewport.
    const update = () => {
      const line = window.innerHeight * 0.33;
      let current = sectionIds[0];
      for (const id of sectionIds) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= line) current = id;
      }
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setActive(atBottom ? sectionIds[sectionIds.length - 1] : current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);
  return (
    <nav className="ws-nav" aria-label="Workspace sections">
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <SectionLink to={item.id} aria-current={active === item.id ? "location" : undefined}>
              <span>{item.label}</span>
              {item.count !== undefined ? <span className="tabular">{item.count}</span> : null}
            </SectionLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The configured workspace: routing flow first, then repos, schedules, credentials, policy. */
export function WorkspaceConfigScreen({
  response,
  config,
}: {
  response: WorkspaceResponse;
  config: WorkspaceConfigView;
}) {
  const flow = buildWorkspaceFlow(config);
  const issues = collectIssues(config, flow);
  const envSources = collectEnvSources(config);
  const nav: NavItem[] = [
    { id: "ws-flow", label: "Work routing", count: flow.sources.length },
    { id: "ws-repos", label: "Repositories", count: config.repos.length },
    { id: "ws-automations", label: "Automations", count: config.automations.length },
    ...(config.estimations.length > 0
      ? [{ id: "ws-estimations", label: "Estimations", count: config.estimations.length }]
      : []),
    ...(config.errorMonitors.length > 0
      ? [{ id: "ws-monitors", label: "Error monitors", count: config.errorMonitors.length }]
      : []),
    { id: "ws-credentials", label: "Credentials", count: envSources.length },
    { id: "ws-execution", label: "Policy" },
  ];

  return (
    <div className="ws-layout">
      <SectionNav items={nav} />
      <div className="ws-main">
        <header className="space-y-3">
          <MetaBar response={response} />
          <ConfigSyncNotice response={response} />
          {issues.length > 0 ? (
            <Callout
              tone="warning"
              icon={<TriangleAlert className="size-4" aria-hidden="true" />}
              title={`${issues.length} ${issues.length === 1 ? "thing needs" : "things need"} attention`}
            >
              <ul className="space-y-0.5">
                {issues.map((issue) => (
                  <li key={issue.id}>
                    <SectionLink to={issue.anchor} className="ref-link">
                      {issue.message}
                    </SectionLink>
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </header>

        <WorkspaceSection
          id="ws-flow"
          title="Work routing"
          description={`Where tracker tickets, automation runs, and error alerts land.${
            flow.sources.length > 0 && config.repos.length > 0
              ? " Hover or focus a source or repository to trace its route."
              : ""
          }`}
        >
          {flow.sources.length > 0 && config.repos.length > 0 ? (
            <WorkspaceFlowDiagram flow={flow} />
          ) : (
            <WorkspaceEmpty
              title={config.repos.length === 0 ? "Nothing to route yet" : "No work sources"}
              body={
                config.repos.length === 0 ? (
                  <>
                    Add a repository and a tracker query to see where each ticket lands.{" "}
                    <code className="font-mono text-xs">devintern worker init</code> inside a
                    checkout sets up both.
                  </>
                ) : (
                  <>
                    No tracker team, automation, or error monitor feeds this workspace. Add{" "}
                    <code className="font-mono text-xs">[[teams]]</code> or a{" "}
                    <code className="font-mono text-xs">[defaults].task_query</code> so the worker
                    picks up tickets.
                  </>
                )
              }
              action={<DocsButton />}
            />
          )}
        </WorkspaceSection>

        <WorkspaceSection id="ws-repos" title="Repositories">
          <ReposTable
            repos={config.repos}
            order={flow.repos.map((repo) => repo.name)}
            defaultPipeline={config.defaults.pipelineFile}
          />
        </WorkspaceSection>

        <WorkspaceSection
          id="ws-automations"
          title="Automations"
          description="Each runs a prompt through the task pipeline on its schedule. Open one for its recent runs."
        >
          {config.automations.length > 0 ? (
            <AutomationsTable automations={config.automations} />
          ) : (
            <WorkspaceEmpty
              title="No automations configured"
              body={
                <>
                  Add an <code className="font-mono text-xs">[[automations]]</code> entry with an
                  id, a cron or interval, and a prompt. The worker picks it up without a restart.
                </>
              }
            />
          )}
        </WorkspaceSection>

        {config.estimations.length > 0 ? (
          <WorkspaceSection
            id="ws-estimations"
            title="Estimations"
            description="Scheduled sweeps that estimate matching tracker tasks."
          >
            <EstimationsTable estimations={config.estimations} tracker={config.defaults.tracker} />
          </WorkspaceSection>
        ) : null}

        {config.errorMonitors.length > 0 ? (
          <WorkspaceSection
            id="ws-monitors"
            title="Error monitors"
            description="Recurring errors become tasks in the mapped repository."
          >
            <MonitorsTable monitors={config.errorMonitors} />
          </WorkspaceSection>
        ) : null}

        <WorkspaceSection
          id="ws-credentials"
          title="Credentials"
          description="Env files and inline env tables per scope. Only variable names are shown; values stay on this machine."
        >
          <CredentialsList config={config} />
        </WorkspaceSection>

        <WorkspaceSection id="ws-execution" title="Policy">
          <ExecutionSettings config={config} />
        </WorkspaceSection>
      </div>
    </div>
  );
}

function MissingConfig({ response }: { response: WorkspaceResponse }) {
  return (
    <div className="ws-layout">
      <div className="ws-main ws-state">
        <EmptyState
          icon={FileQuestion}
          title="No workspace config yet"
          body="The worker reads its trackers, repositories, and automations from workspace.toml. Create it from inside a repository checkout:"
          action={
            <div className="flex flex-col items-center gap-4">
              <code className="-mt-2 font-mono text-xs text-subtle-foreground">
                {response.configPath}
              </code>
              <pre className="ws-commands">
                <code>
                  <span className="subtle-text">
                    # writes workspace.toml and registers this repo
                  </span>
                  {"\n"}devintern worker init{"\n"}
                  <span className="subtle-text"># later, from each additional repo</span>
                  {"\n"}devintern worker add-repo
                </code>
              </pre>
              <DocsButton label="Read the workspace guide" />
            </div>
          }
        />
      </div>
    </div>
  );
}

function InvalidConfig({
  response,
  error,
  problems,
}: {
  response: WorkspaceResponse;
  error: string;
  problems: string[];
}) {
  const count = problems.length;
  return (
    <div className="ws-layout">
      <div className="ws-main ws-state">
        <MetaBar response={response} />
        <div role="alert" className="ws-invalid">
          <div className="flex items-start gap-3">
            <span className="ws-callout-icon text-danger">
              <FileWarning className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="section-title">
                {count > 1 ? `workspace.toml has ${count} problems` : "workspace.toml is invalid"}
              </h2>
              <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
                {response.workerStartedAt
                  ? "The running worker ignores this edit and keeps its last valid config until the file is fixed."
                  : "The worker will not start until the file is fixed."}
              </p>
            </div>
          </div>
          {count > 0 ? (
            <ol className="ws-problems">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ol>
          ) : (
            <p className="ws-problems font-mono">{error}</p>
          )}
        </div>
        <DocsButton label="Workspace config reference" />
      </div>
    </div>
  );
}

function LoadingWorkspace() {
  return (
    <div role="status" aria-label="Loading workspace" className="ws-layout">
      <div className="ws-main">
        <div className="skeleton h-5 w-96 max-w-full" />
        <div className="space-y-3">
          <div className="skeleton h-5 w-32" />
          <div className="skeleton h-64 w-full" />
        </div>
        <div className="space-y-3">
          <div className="skeleton h-5 w-28" />
          <div className="skeleton h-40 w-full" />
        </div>
      </div>
    </div>
  );
}

/** Pure render of a `GET /api/workspace` body (exported for tests). */
export function WorkspaceScreen({ response }: { response: WorkspaceResponse }) {
  if (response.status === "missing") return <MissingConfig response={response} />;
  if (response.status === "invalid") {
    return (
      <InvalidConfig response={response} error={response.error} problems={response.problems} />
    );
  }
  return <WorkspaceConfigScreen response={response} config={response.config} />;
}

/** Read-only view of `workspace.toml`. */
export function WorkspaceView() {
  const { data, error, loading, refresh } = usePoll<WorkspaceResponse>(WORKSPACE_URL, 15_000);
  if (!data && loading) return <LoadingWorkspace />;
  if (!data) {
    return (
      <div className="space-y-3">
        <EmptyState title="Could not load the workspace" body={error ?? "Unknown error"} />
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCcw /> Try again
        </Button>
      </div>
    );
  }
  return <WorkspaceScreen response={data} />;
}
