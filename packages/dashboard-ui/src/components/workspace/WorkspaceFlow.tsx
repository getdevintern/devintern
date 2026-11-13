import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  FolderGit2,
  Radar,
  TicketCheck,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { SectionLink } from "@/components/workspace/SectionLink";
import { cn } from "@/lib/utils";
import { describeFlow, describeRemote, routeLabel } from "@/components/workspace/workspace-model";
import type {
  FlowFallthrough,
  FlowRoute,
  FlowSource,
  FlowSourceKind,
  WorkspaceFlow,
} from "@/components/workspace/workspace-model";

const GROUPS: { kinds: FlowSourceKind[]; label: string; icon: LucideIcon }[] = [
  { kinds: ["team", "defaults"], label: "Tracker sources", icon: TicketCheck },
  { kinds: ["automations"], label: "Automations", icon: CalendarClock },
  { kinds: ["monitor"], label: "Error monitors", icon: Radar },
];

/** The wired diagram needs this width; below it the CSS stacks sources (see workspace.css). */
export const DIAGRAM_MEDIA_QUERY = "(min-width: 1024px)";

/** Vertical gap between repo cards once they are positioned. */
const REPO_GAP = 10;

interface Wire {
  key: string;
  source: string;
  repo: string;
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
}

interface Layout {
  /** Card top (px, relative to the repo column) by repo name. */
  tops: Record<string, number>;
  /** Column height needed to hold every card. */
  height: number;
  wires: Wire[];
}

type Focus = { source: string } | { repo: string } | null;

/** The trace a focused diagram element drives (its source row or repo card), if any. */
export function focusFromElement(
  element: {
    closest(selector: string): { getAttribute(name: string): string | null } | null;
  } | null,
): Focus {
  const source = element?.closest("[data-source-node]")?.getAttribute("data-source-node");
  if (source) return { source };
  const repo = element?.closest("[data-repo-node]")?.getAttribute("data-repo-node");
  return repo ? { repo } : null;
}

/**
 * Top for a repo card: level with its sources, but never above the stack
 * cursor. A drift under one card height snaps to the cursor so spacing stays
 * even; a larger one is kept (capped at one card) to stay near its sources.
 */
export function placeRepoTop(cursor: number, desired: number, height: number): number {
  const top = Math.min(Math.max(cursor, Math.round(desired)), cursor + height);
  return top - cursor < height ? cursor : top;
}

function wireActive(wire: Wire, focus: Focus): boolean | undefined {
  if (!focus) return undefined;
  return "source" in focus ? wire.source === focus.source : wire.repo === focus.repo;
}

function sameLayout(a: Layout | null, b: Layout): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Place each repo card at the mean height of the route chips that feed it
 * (keeping the model's order and a fixed gap), then draw one wire per chip,
 * with arrivals spread down the card's left edge in source order.
 */
function useFlowLayout(flow: WorkspaceFlow) {
  const containerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLUListElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const column = columnRef.current;
    if (!container || !column) return;
    const wide = window.matchMedia(DIAGRAM_MEDIA_QUERY);
    const measure = () => {
      if (!wide.matches || column.getClientRects().length === 0) {
        // Narrow layout: no diagram column, no wires, no positioned cards.
        setLayout((previous) => (previous === null ? previous : null));
        return;
      }
      const box = container.getBoundingClientRect();
      const columnBox = column.getBoundingClientRect();
      const chips = [...container.querySelectorAll<HTMLElement>("[data-route-repo]")];
      const chipsByRepo = new Map<string, { chip: HTMLElement; y: number }[]>();
      for (const chip of chips) {
        const repo = chip.dataset.routeRepo ?? "";
        const rect = chip.getBoundingClientRect();
        const entry = { chip, y: rect.top + rect.height / 2 - columnBox.top };
        chipsByRepo.set(repo, [...(chipsByRepo.get(repo) ?? []), entry]);
      }

      const tops: Record<string, number> = {};
      // The first card starts level with the first source row (no empty band).
      const firstRow = container.querySelector<HTMLElement>(".wsf-source");
      const firstRowTop = firstRow
        ? Math.max(0, Math.round(firstRow.getBoundingClientRect().top - columnBox.top))
        : 0;
      let cursor = firstRowTop;
      const heights = new Map<string, number>();
      for (const repo of flow.repos) {
        const node = column.querySelector<HTMLElement>(
          `[data-repo-node="${CSS.escape(repo.name)}"]`,
        );
        const height = node?.offsetHeight ?? 0;
        heights.set(repo.name, height);
        const feeds = chipsByRepo.get(repo.name);
        const desired = feeds
          ? feeds.reduce((sum, feed) => sum + feed.y, 0) / feeds.length - height / 2
          : cursor;
        // Never drift more than about one card below the previous card, or a
        // big empty gap opens above it.
        const top = placeRepoTop(cursor, desired, height);
        tops[repo.name] = top;
        cursor = top + height + REPO_GAP;
      }
      // Shift the stack up so the first card sits level with the first source
      // row; relative spacing (and so wire slopes) is kept.
      const firstName = flow.repos[0]?.name;
      const lift = firstName ? Math.max(0, (tops[firstName] ?? 0) - firstRowTop) : 0;
      for (const name of Object.keys(tops)) tops[name] = (tops[name] ?? 0) - lift;
      const height = Math.max(0, cursor - REPO_GAP - lift);

      const wires: Wire[] = [];
      const x2 = columnBox.left - box.left;
      for (const repo of flow.repos) {
        const feeds = [...(chipsByRepo.get(repo.name) ?? [])].sort((a, b) => a.y - b.y);
        const cardTop = (tops[repo.name] ?? 0) + columnBox.top - box.top;
        const cardHeight = heights.get(repo.name) ?? 0;
        feeds.forEach(({ chip }, index) => {
          const start = chip.getBoundingClientRect();
          const x1 = start.right - box.left;
          const y1 = start.top + start.height / 2 - box.top;
          // Spread arrivals evenly down the card's left edge.
          const y2 = Math.round(cardTop + ((index + 1) * cardHeight) / (feeds.length + 1));
          const dx = Math.max(24, (x2 - x1) * 0.5);
          wires.push({
            key: chip.dataset.routeKey ?? `${repo.name}:${index}`,
            source: chip.dataset.source ?? "",
            repo: repo.name,
            d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
            x1,
            y1,
            x2,
            y2,
            dashed: chip.dataset.disabled === "true",
          });
        });
      }
      const next: Layout = { tops, height, wires };
      setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    wide.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      wide.removeEventListener("change", measure);
    };
  }, [flow]);

  return { containerRef, columnRef, layout };
}

function routeTitle(source: FlowSource, route: Exclude<FlowRoute, { kind: "unrouted" }>): string {
  const base = `${routeLabel(route, source.kind, source.disabled)} \u2192 ${route.repo}`;
  const notes = [
    route.known ? null : "not a configured repo",
    route.kind === "rule" && !route.scoped
      ? "unscoped rule: applies to every team without a fixed repo"
      : null,
  ].filter(Boolean);
  return notes.length > 0 ? `${base} (${notes.join("; ")})` : base;
}

function RouteChip({
  source,
  route,
  index,
}: {
  source: FlowSource;
  route: FlowRoute;
  index: number;
}) {
  if (route.kind === "unrouted") {
    return (
      <span
        className="wsf-route wsf-route-warn"
        title="No route: tasks from this source are skipped"
      >
        <TriangleAlert className="size-3" aria-hidden="true" />
        No route, tasks skipped
      </span>
    );
  }
  const quiet = route.kind === "fixed" || route.kind === "only";
  return (
    <span
      className={cn("wsf-route", quiet && "wsf-route-quiet", !route.known && "wsf-route-warn")}
      data-route-repo={route.known ? route.repo : undefined}
      data-route-key={`${source.id}:${index}`}
      data-source={source.id}
      data-disabled={source.disabled ? "true" : undefined}
      title={routeTitle(source, route)}
    >
      <span className="wsf-route-label">{routeLabel(route, source.kind, source.disabled)}</span>
      {/* Visible when the diagram collapses; read by screen readers always. */}
      <span className={cn("wsf-route-target", !route.known && "wsf-route-target-shown")}>
        <ArrowRight className="size-3" aria-hidden="true" />
        <span className="sr-only">to</span>
        <span className="wsf-route-repo">{route.repo}</span>
        {!route.known ? <span className="wsf-route-repo-note">(unknown repo)</span> : null}
      </span>
    </span>
  );
}

/** Trailing "otherwise" chip: what the worker does when no rule routes a task. */
function FallthroughChip({ fallthrough }: { fallthrough: FlowFallthrough }) {
  if (fallthrough.kind === "repo") {
    return (
      <span
        className="wsf-route wsf-route-quiet wsf-route-otherwise"
        title="A one-repo workspace sends tasks no rule matches to its only repo."
      >
        <span className="wsf-route-label">otherwise</span>
        <span className="wsf-route-target wsf-route-target-shown">
          <ArrowRight className="size-3" aria-hidden="true" />
          <span className="sr-only">to</span>
          <span className="wsf-route-repo">{fallthrough.repo}</span>
        </span>
      </span>
    );
  }
  return (
    <span
      className="wsf-route wsf-route-quiet wsf-route-otherwise"
      title="Tasks no rule matches, or that match rules for different repos, are skipped and recorded; the worker retries them when the task changes."
    >
      otherwise skipped
    </span>
  );
}

function routeSummary(source: FlowSource): string {
  return source.routes
    .map((route) =>
      route.kind === "unrouted"
        ? "no route"
        : `${routeLabel(route, source.kind, source.disabled)} to ${route.repo}`,
    )
    .concat(
      source.fallthrough?.kind === "skipped"
        ? ["otherwise skipped"]
        : source.fallthrough?.kind === "repo"
          ? [`otherwise to ${source.fallthrough.repo}`]
          : [],
    )
    .join("; ");
}

function SourceRow({
  source,
  dim,
  interactive,
  onFocus,
  onLeave,
}: {
  source: FlowSource;
  dim: boolean;
  /** Wires are drawn: rows are focusable and trace on hover/focus. */
  interactive: boolean;
  onFocus: (focus: Focus) => void;
  onLeave: () => void;
}) {
  const title =
    source.kind === "automations" ? (
      <SectionLink to="ws-automations" className="hover:underline" tabIndex={-1}>
        {source.title}
      </SectionLink>
    ) : (
      source.title
    );
  return (
    // Focusable so keyboard users can trace a source's wires like hover does.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus drives wire tracing
    <li
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `${source.title}: ${routeSummary(source)}` : undefined}
      data-source-node={source.id}
      className={cn("wsf-source", source.disabled && "wsf-source-disabled", dim && "wsf-dim")}
      onMouseEnter={interactive ? () => onFocus({ source: source.id }) : undefined}
      onMouseLeave={interactive ? onLeave : undefined}
      onFocus={interactive ? () => onFocus({ source: source.id }) : undefined}
      onBlur={interactive ? () => onFocus(null) : undefined}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="wsf-kind">{source.badge}</span>
          <span className="min-w-0 truncate font-medium" title={source.title}>
            {title}
          </span>
          {source.disabled && source.kind !== "automations" ? (
            <span className="text-xs text-subtle-foreground">disabled</span>
          ) : null}
        </div>
        {source.query ? (
          <code className="wsf-query" title={source.query}>
            {source.query}
          </code>
        ) : null}
        {source.note || source.envMissing ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
            {source.note ? <span>{source.note}</span> : null}
            {source.envMissing ? (
              <span className="inline-flex items-center gap-1 text-warning">
                <TriangleAlert className="size-3" aria-hidden="true" />
                Env file missing
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="wsf-routes">
        {source.routes.map((route, index) => (
          <RouteChip
            key={
              route.kind === "unrouted"
                ? "unrouted"
                : `${route.kind}:${route.repo}:${route.kind === "rule" ? route.criteria.join("|") : ""}`
            }
            source={source}
            route={route}
            index={index}
          />
        ))}
        {source.fallthrough ? <FallthroughChip fallthrough={source.fallthrough} /> : null}
      </div>
    </li>
  );
}

/**
 * Sources → routing → repositories, drawn as a wired diagram on wide screens
 * and as a stacked mapping ("all tasks → repo" on each chip) on narrow ones.
 * Hovering or keyboard-focusing a source or repo highlights its wires.
 */
export function WorkspaceFlowDiagram({ flow }: { flow: WorkspaceFlow }) {
  const { containerRef, columnRef, layout } = useFlowLayout(flow);
  const [focus, setFocus] = useState<Focus>(null);
  // No layout means no wires (narrow screens): nothing to trace, so no tab stops.
  const interactive = layout !== null;
  // Hover leaving must not clear a trace the keyboard is still driving.
  const clearUnlessFocused = () => {
    // Restore the keyboard trace instead of leaving the hovered one behind.
    const active = document.activeElement;
    if (active && containerRef.current?.contains(active) && active !== containerRef.current) {
      setFocus(focusFromElement(active));
      return;
    }
    setFocus(null);
  };
  const summaryId = useId();
  const wires = layout?.wires ?? [];
  const idleRepos = flow.repos.filter((repo) => repo.inbound === 0);

  const linkedSources = new Set(
    focus && "repo" in focus ? wires.filter((w) => w.repo === focus.repo).map((w) => w.source) : [],
  );
  const linkedRepos = new Set(
    focus && "source" in focus
      ? wires.filter((w) => w.source === focus.source).map((w) => w.repo)
      : [],
  );

  return (
    <div
      ref={containerRef}
      className="wsf"
      role="group"
      aria-label="Work routing diagram"
      aria-describedby={summaryId}
      data-positioned={layout ? "true" : undefined}
    >
      <p id={summaryId} className="sr-only">
        {describeFlow(flow)}
      </p>
      <div className="wsf-col-head wsf-col-head-sources" aria-hidden="true">
        <span>Source</span>
        <span>Route</span>
      </div>
      <div className="wsf-col-head wsf-col-head-repos" aria-hidden="true">
        Repository
      </div>

      <div className="wsf-sources">
        {GROUPS.map((group) => {
          const sources = flow.sources.filter((source) => group.kinds.includes(source.kind));
          if (sources.length === 0) return null;
          const Icon = group.icon;
          return (
            <section key={group.label} className="wsf-group" aria-label={group.label}>
              <h3 className="wsf-group-label">
                <Icon className="size-3.5" aria-hidden="true" />
                {group.label}
              </h3>
              <ul className="wsf-list">
                {sources.map((source) => (
                  <SourceRow
                    key={source.id}
                    source={source}
                    dim={Boolean(
                      focus &&
                      (("repo" in focus && !linkedSources.has(source.id)) ||
                        ("source" in focus && focus.source !== source.id)),
                    )}
                    interactive={interactive}
                    onFocus={setFocus}
                    onLeave={clearUnlessFocused}
                  />
                ))}
              </ul>
            </section>
          );
        })}
        {idleRepos.length > 0 ? (
          <p className="wsf-idle">
            <FolderGit2 className="size-3.5 shrink-0" aria-hidden="true" />
            <span>
              No routes into{" "}
              {idleRepos.map((repo, index) => (
                <span key={repo.name}>
                  {index > 0 ? ", " : null}
                  <SectionLink
                    to={`ws-repo-${repo.name}`}
                    className="font-medium text-foreground hover:underline"
                  >
                    {repo.name}
                  </SectionLink>
                </span>
              ))}
              ; {idleRepos.length === 1 ? "it takes" : "they take"} ad-hoc tasks only.
            </span>
          </p>
        ) : null}
      </div>

      <svg className="wsf-wires" aria-hidden="true">
        {wires.map((wire) => {
          const active = wireActive(wire, focus);
          return (
            <g
              key={wire.key}
              className="wsf-wire"
              data-active={active === undefined ? undefined : String(active)}
              data-dashed={wire.dashed ? "true" : undefined}
            >
              <path d={wire.d} />
              <circle cx={wire.x1} cy={wire.y1} r={2.5} />
              <circle cx={wire.x2} cy={wire.y2} r={2.5} />
            </g>
          );
        })}
      </svg>

      <ul
        ref={columnRef}
        className="wsf-repos"
        aria-label="Repositories"
        style={layout ? { height: layout.height } : undefined}
      >
        {flow.repos.map((repo) => {
          const remote = describeRemote(repo.remote);
          const dim = Boolean(
            focus &&
            (("source" in focus && !linkedRepos.has(repo.name)) ||
              ("repo" in focus && focus.repo !== repo.name)),
          );
          const top = layout?.tops[repo.name];
          return (
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus drives wire tracing
            <li
              key={repo.name}
              tabIndex={interactive ? 0 : undefined}
              aria-label={
                interactive
                  ? `${repo.name}, ${remote.label}: ${
                      repo.inbound === 0
                        ? "no routes, ad-hoc tasks only"
                        : `${repo.inbound} ${repo.inbound === 1 ? "source" : "sources"}`
                    }`
                  : undefined
              }
              className={cn("wsf-repo", repo.inbound === 0 && "wsf-repo-idle", dim && "wsf-dim")}
              style={top === undefined ? undefined : { top }}
              data-repo-node={repo.name}
              onMouseEnter={interactive ? () => setFocus({ repo: repo.name }) : undefined}
              onMouseLeave={interactive ? clearUnlessFocused : undefined}
              onFocus={interactive ? () => setFocus({ repo: repo.name }) : undefined}
              onBlur={interactive ? () => setFocus(null) : undefined}
            >
              <FolderGit2 className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <div className="truncate font-medium" title={repo.name}>
                  {repo.name}
                </div>
                <div
                  className="truncate font-mono text-xs text-subtle-foreground"
                  title={repo.remote}
                >
                  {remote.label}
                </div>
                {repo.inbound === 0 ? (
                  <div className="mt-0.5 text-xs text-subtle-foreground">
                    No routes; ad-hoc tasks only
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
