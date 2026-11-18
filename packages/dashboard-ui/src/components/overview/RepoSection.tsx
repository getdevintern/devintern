import { Badge } from "@/components/ui/badge";
import type { OverviewCapacity } from "@/lib/api-overview";
import { cn } from "@/lib/utils";
import { PANEL, Section, Meter, CapacityBadge } from "@/components/overview/OverviewPanel";

export function RepoSection({
  capacity,
  stalled,
  configOk,
}: {
  capacity: OverviewCapacity;
  stalled: boolean;
  configOk: boolean;
}) {
  if (capacity.perRepo.length === 0 && capacity.unattributed === 0) return null;
  const perRepoMax = capacity.perRepo[0]?.maxConcurrency ?? null;
  const busy = capacity.perRepo.filter((repo) => repo.running > 0);
  const idle = capacity.perRepo.filter((repo) => repo.running === 0);
  return (
    <Section
      id="ov-repos"
      title="By repository"
      meta={perRepoMax !== null ? `up to ${perRepoMax} runs per repo` : undefined}
    >
      <ul className={cn(PANEL, "divide-y divide-border")}>
        {busy.map((repo) => (
          <li
            key={repo.repo}
            className="grid min-h-11 grid-cols-[minmax(0,1fr)_minmax(5rem,11rem)_3rem] items-center gap-4 px-4 py-2 text-[0.8125rem]"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-foreground" title={repo.repo}>
                {repo.repo}
              </span>
              {!repo.configured && configOk ? (
                <span title="Runs recorded this repo, but it is not declared in workspace.toml">
                  <Badge variant="outline">not in workspace</Badge>
                </span>
              ) : null}
              {stalled ? null : <CapacityBadge running={repo.running} max={repo.maxConcurrency} />}
            </span>
            {repo.maxConcurrency !== null ? (
              <Meter
                running={repo.running}
                max={repo.maxConcurrency}
                label={`${repo.repo} capacity`}
                size="sm"
                stalled={stalled}
              />
            ) : (
              <span />
            )}
            <span className="text-right font-semibold text-foreground tabular-nums">
              {repo.running}
              {repo.maxConcurrency !== null ? (
                <span className="font-normal text-subtle-foreground"> / {repo.maxConcurrency}</span>
              ) : null}
            </span>
          </li>
        ))}
        {capacity.unattributed > 0 ? (
          <li className="flex min-h-11 items-center justify-between gap-4 px-4 py-2 text-[0.8125rem]">
            <span className="text-muted-foreground">No repository recorded</span>
            <span className="font-semibold text-foreground tabular-nums">
              {capacity.unattributed}
            </span>
          </li>
        ) : null}
        {idle.length > 0 ? (
          <li className="flex min-h-11 items-center gap-3 px-4 py-2 text-[0.8125rem]">
            <span className="shrink-0 text-muted-foreground">
              {busy.length > 0 ? `${idle.length} more` : idle.length}{" "}
              {idle.length === 1 ? "repo" : "repos"} idle
            </span>
            <span
              className="min-w-0 truncate text-subtle-foreground"
              title={idle.map((repo) => repo.repo).join(", ")}
            >
              {idle.map((repo) => repo.repo).join(", ")}
            </span>
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

/* ---------- Harness chain ---------- */
