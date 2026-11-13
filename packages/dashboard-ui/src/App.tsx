import { useEffect, useState } from "react";
import {
  TerminalSquare,
  ChartNoAxesCombined,
  GitPullRequest,
  LayoutDashboard,
  ListTodo,
  Settings2,
  ScrollText,
  Workflow,
} from "lucide-react";

import { StatusStrip } from "@/components/StatusStrip";
import { AgentPrsView } from "@/views/AgentPrsView";
import { AutomationsView } from "@/views/AutomationsView";
import { LogsView } from "@/views/LogsView";
import { RunDetailView } from "@/views/RunDetailView";
import { RunsView } from "@/views/RunsView";
import { AutomationDetailView } from "@/views/AutomationDetailView";
import { StatsView } from "@/views/StatsView";
import { OverviewView } from "@/views/OverviewView";
import { WorkspaceView } from "@/views/WorkspaceView";
import { parseHash, redirectHash, RUNS_HASH, runHash } from "@/lib/routes";
import type { Route } from "@/lib/routes";
import { cn } from "@/lib/utils";

const sections = [
  { label: "Overview", hash: "#/", view: "overview", icon: LayoutDashboard },
  { label: "Runs", hash: RUNS_HASH, view: "runs", icon: ListTodo },
  { label: "Automations", hash: "#/automations", view: "automations", icon: Workflow },
  { label: "Pull requests", hash: "#/prs", view: "prs", icon: GitPullRequest },
  { label: "Statistics", hash: "#/stats", view: "stats", icon: ChartNoAxesCombined },
  { label: "Workspace", hash: "#/workspace", view: "workspace", icon: Settings2 },
  { label: "Logs", hash: "#/logs", view: "logs", icon: ScrollText },
] as const;

const pageTitles: Record<Route["view"], string> = {
  overview: "Overview",
  runs: "Runs",
  run: "Runs",
  automations: "Automations",
  automation: "Automations",
  prs: "Pull requests",
  stats: "Statistics",
  logs: "Worker logs",
  workspace: "Workspace",
};

/** Route for the current hash, first rewriting a retired hash in place (no history entry). */
const currentHash = (): Route => {
  const redirect = redirectHash(window.location.hash);
  if (redirect !== null) {
    window.history.replaceState(null, "", redirect);
    return parseHash(redirect);
  }
  return parseHash(window.location.hash);
};
const openRun = (id: number): void => {
  window.location.hash = runHash(id);
};

export function App() {
  const [route, setRoute] = useState<Route>(currentHash);

  useEffect(() => {
    const onHashChange = () => setRoute(currentHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Keep the active tab visible when the tab row scrolls (narrow screens).
  useEffect(() => {
    const reveal = () =>
      document
        .querySelector(".dashboard-nav-link-active")
        ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    reveal();
    // A resize can clip the active tab again; debounce so a drag costs one scroll.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(reveal, 100);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [route.view]);

  const currentSection =
    route.view === "run" ? "runs" : route.view === "automation" ? "automations" : route.view;

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <a className="dashboard-brand" href="#/" aria-label="DevIntern dashboard home">
          <span className="dashboard-brand-mark" aria-hidden="true">
            <TerminalSquare size={17} strokeWidth={2.25} />
          </span>
          <span className="dashboard-brand-name">
            DevIntern <small>Dashboard</small>
          </span>
        </a>

        <nav className="dashboard-nav" aria-label="Dashboard sections">
          {sections.map((section) => {
            const Icon = section.icon;
            const active = currentSection === section.view;
            return (
              <a
                key={section.view}
                href={section.hash}
                aria-current={active ? "page" : undefined}
                className={cn("dashboard-nav-link", active && "dashboard-nav-link-active")}
              >
                <Icon size={18} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
                <span>{section.label}</span>
              </a>
            );
          })}
        </nav>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <h1 className="dashboard-page-title">
            {route.view === "run" ? (
              <>
                <a href={RUNS_HASH}>Runs</a> <span>/ #{route.id}</span>
              </>
            ) : route.view === "automation" ? (
              <>
                <a href="#/automations">Automations</a> <span>/ {route.id}</span>
              </>
            ) : (
              pageTitles[route.view]
            )}
          </h1>
          <StatusStrip />
        </header>

        <main className="dashboard-content">
          {route.view === "overview" ? <OverviewView /> : null}
          {route.view === "runs" ? <RunsView onOpenRun={openRun} /> : null}
          {route.view === "run" ? (
            <RunDetailView
              key={route.id}
              runId={route.id}
              onBack={() => (window.location.hash = RUNS_HASH)}
            />
          ) : null}
          {route.view === "automations" ? <AutomationsView onOpenRun={openRun} /> : null}
          {route.view === "automation" ? (
            <AutomationDetailView key={route.id} automationId={route.id} />
          ) : null}
          {route.view === "prs" ? <AgentPrsView /> : null}
          {route.view === "stats" ? <StatsView /> : null}
          {route.view === "logs" ? <LogsView /> : null}
          {route.view === "workspace" ? <WorkspaceView /> : null}
        </main>
      </div>
    </div>
  );
}
