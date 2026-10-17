import { useEffect, useState } from "react";
import {
  Activity,
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
import { StatsView } from "@/views/StatsView";
import { cn } from "@/lib/utils";

type Route =
  | { view: "runs" }
  | { view: "run"; id: number }
  | { view: "automations" }
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
  if (hash === "#/automations") return { view: "automations" };
  if (hash === "#/stats") return { view: "stats" };
  if (hash === "#/prs") return { view: "prs" };
  if (hash === "#/logs") return { view: "logs" };
  return { view: "runs" };
}

const sections = [
  { label: "Runs", hash: "#/", view: "runs", icon: ListTodo },
  { label: "Automations", hash: "#/automations", view: "automations", icon: Workflow },
  { label: "Pull requests", hash: "#/prs", view: "prs", icon: GitPullRequest },
  { label: "Statistics", hash: "#/stats", view: "stats", icon: ChartNoAxesCombined },
  { label: "Logs", hash: "#/logs", view: "logs", icon: ScrollText },
] as const;

const pageCopy = {
  runs: { title: "Runs", description: "Follow work from pickup through delivery." },
  run: { title: "Run details", description: "Review the timeline, output, and next steps." },
  automations: { title: "Automations", description: "Manage scheduled work and run it on demand." },
  prs: { title: "Pull requests", description: "Review work opened by your agents." },
  stats: { title: "Statistics", description: "See how your agents perform over time." },
  logs: { title: "Worker logs", description: "Inspect the worker's latest activity." },
};

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const currentSection = route.view === "run" ? "runs" : route.view;
  const page = pageCopy[route.view];

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <a className="dashboard-brand" href="#/" aria-label="DevIntern dashboard home">
          <span className="dashboard-brand-mark" aria-hidden="true">
            <Activity size={22} strokeWidth={2.5} />
          </span>
          <span className="dashboard-brand-name">
            DevIntern <small>Dashboard</small>
          </span>
        </a>

        <div className="dashboard-nav-label">Workspace</div>
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

        <div className="dashboard-sidebar-foot">
          <span className="dashboard-local-dot" />
          Local workspace
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <span className="dashboard-topbar-title">Worker overview</span>
          <StatusStrip />
        </header>

        <main className="dashboard-content">
          <div className="dashboard-page-heading">
            <div>
              <h1>{page.title}</h1>
              <p>{page.description}</p>
            </div>
            <span className="dashboard-live-label">
              <span className="dashboard-live-dot" /> Checks every 5s
            </span>
          </div>

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
          {route.view === "prs" ? <AgentPrsView /> : null}
          {route.view === "stats" ? <StatsView /> : null}
          {route.view === "logs" ? <LogsView /> : null}
        </main>
      </div>
    </div>
  );
}
