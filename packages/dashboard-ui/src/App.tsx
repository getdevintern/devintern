import { useEffect, useState } from "react";
import {
  Activity,
  TerminalSquare,
  ChartNoAxesCombined,
  GitPullRequest,
  ListTodo,
  ScrollText,
  Workflow,
} from "lucide-react";

import { StatusStrip } from "@/components/StatusStrip";
import { AgentPrsView } from "@/views/AgentPrsView";
import { AutomationsView } from "@/views/AutomationsView";
import { LogsView } from "@/views/LogsView";
import { RunDetailView } from "@/views/RunDetailView";
import { RunsView } from "@/views/RunsView";
import { TaskActivityView } from "@/views/TaskActivityView";
import { AutomationDetailView } from "@/views/AutomationDetailView";
import { StatsView } from "@/views/StatsView";
import { cn } from "@/lib/utils";

type Route =
  | { view: "activity" }
  | { view: "runs" }
  | { view: "run"; id: number }
  | { view: "automations" }
  | { view: "automation"; id: string }
  | { view: "prs" }
  | { view: "stats" }
  | { view: "logs" };

/** Parse the location hash (#/, #/runs/:id, #/automations, #/prs, #/stats, #/logs) into a route. */
function parseHash(): Route {
  const hash = window.location.hash;
  const runMatch = hash.match(/^#\/runs\/(\d+)$/);
  if (runMatch) {
    return { view: "run", id: parseInt(runMatch[1] ?? "0", 10) };
  }
  if (hash === "#/activity") return { view: "activity" };
  const automationMatch = hash.match(/^#\/automations\/(.+)$/);
  if (automationMatch) {
    try {
      return { view: "automation", id: decodeURIComponent(automationMatch[1] ?? "") };
    } catch {
      return { view: "automations" };
    }
  }
  if (hash === "#/automations") return { view: "automations" };
  if (hash === "#/stats") return { view: "stats" };
  if (hash === "#/prs") return { view: "prs" };
  if (hash === "#/logs") return { view: "logs" };
  return { view: "runs" };
}

const sections = [
  { label: "Runs", hash: "#/", view: "runs", icon: ListTodo },
  { label: "Task activity", hash: "#/activity", view: "activity", icon: Activity },
  { label: "Automations", hash: "#/automations", view: "automations", icon: Workflow },
  { label: "Pull requests", hash: "#/prs", view: "prs", icon: GitPullRequest },
  { label: "Statistics", hash: "#/stats", view: "stats", icon: ChartNoAxesCombined },
  { label: "Logs", hash: "#/logs", view: "logs", icon: ScrollText },
] as const;

const pageTitles = {
  activity: "Task activity",
  runs: "Runs",
  run: "Runs",
  automations: "Automations",
  automation: "Automations",
  prs: "Pull requests",
  stats: "Statistics",
  logs: "Worker logs",
};

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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
                <a href="#/">Runs</a> <span>/ #{route.id}</span>
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
          {route.view === "activity" ? (
            <TaskActivityView onOpenRun={(id) => (window.location.hash = `#/runs/${id}`)} />
          ) : null}
          {route.view === "runs" ? (
            <RunsView onOpenRun={(id) => (window.location.hash = `#/runs/${id}`)} />
          ) : null}
          {route.view === "run" ? (
            <RunDetailView
              key={route.id}
              runId={route.id}
              onBack={() => (window.location.hash = "#/")}
            />
          ) : null}
          {route.view === "automations" ? (
            <AutomationsView onOpenRun={(id) => (window.location.hash = `#/runs/${id}`)} />
          ) : null}
          {route.view === "automation" ? (
            <AutomationDetailView key={route.id} automationId={route.id} />
          ) : null}
          {route.view === "prs" ? <AgentPrsView /> : null}
          {route.view === "stats" ? <StatsView /> : null}
          {route.view === "logs" ? <LogsView /> : null}
        </main>
      </div>
    </div>
  );
}
