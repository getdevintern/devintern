import { useEffect, useState } from "react";

import { StatusStrip } from "@/components/StatusStrip";
import { buttonVariants } from "@/components/ui/button";
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
  if (hash === "#/automations") {
    return { view: "automations" };
  }
  if (hash === "#/stats") {
    return { view: "stats" };
  }
  if (hash === "#/prs") {
    return { view: "prs" };
  }
  if (hash === "#/logs") {
    return { view: "logs" };
  }
  return { view: "runs" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const tabs = [
    { label: "Runs", hash: "#/", active: route.view === "runs" || route.view === "run" },
    { label: "Automations", hash: "#/automations", active: route.view === "automations" },
    { label: "PRs", hash: "#/prs", active: route.view === "prs" },
    { label: "Stats", hash: "#/stats", active: route.view === "stats" },
    { label: "Logs", hash: "#/logs", active: route.view === "logs" },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">
            DevIntern <span className="text-muted-foreground">dashboard</span>
          </h1>
          <nav className="flex gap-1">
            {tabs.map((tab) => (
              <a
                key={tab.label}
                href={tab.hash}
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  tab.active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </a>
            ))}
          </nav>
        </div>
        <StatusStrip />
      </header>

      {route.view === "runs" ? (
        <RunsView onOpenRun={(id) => (window.location.hash = `#/runs/${id}`)} />
      ) : null}
      {route.view === "run" ? (
        <RunDetailView runId={route.id} onBack={() => (window.location.hash = "#/")} />
      ) : null}
      {route.view === "automations" ? (
        <AutomationsView onOpenRun={(id) => (window.location.hash = `#/runs/${id}`)} />
      ) : null}
      {route.view === "prs" ? <AgentPrsView /> : null}
      {route.view === "stats" ? <StatsView /> : null}
      {route.view === "logs" ? <LogsView /> : null}
    </div>
  );
}
