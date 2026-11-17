import { FolderGit2, Layers } from "lucide-react";

import type { AutomationGroup } from "@/lib/automation-groups";
import { cn } from "@/lib/utils";
// oxlint-disable-next-line import/no-unassigned-import -- group header styles
import "./automation-groups.css";

/**
 * Group header row for an automations table: a `rowgroup` header carrying a
 * heading, so the group is announced with its rows and reachable by heading
 * navigation. `level` matches the surrounding page's outline.
 */
export function AutomationGroupHeaderRow({
  group,
  colSpan,
  level = 2,
}: {
  group: AutomationGroup;
  colSpan: number;
  level?: 2 | 3;
}) {
  const count = group.automations.length;
  const label = group.repo ?? "General";
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <tr className="auto-group-row">
      <th scope="rowgroup" colSpan={colSpan} className="auto-group-cell">
        <Heading className="auto-group-heading">
          {group.repo ? (
            <FolderGit2 className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Layers className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className={cn("truncate", group.repo && "font-mono")} title={label}>
            {label}
          </span>
          <span className="auto-group-count">
            <span aria-hidden="true">{count}</span>
            <span className="sr-only">{count === 1 ? "1 automation" : `${count} automations`}</span>
          </span>
        </Heading>
      </th>
    </tr>
  );
}
