import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/lib/markdown";

/**
 * Characters shown before a long description is collapsed behind a toggle.
 * Generous enough to keep most tickets fully visible without any interaction.
 */
const PREVIEW_LENGTH = 1500;

/**
 * The ticket's original task description, rendered as markdown so it is
 * clearly distinguished from agent-generated step summaries. Blank
 * descriptions (tickets with no body) get an explicit placeholder; callers hide
 * the whole section for non-ticket runs by not rendering it at all.
 */
/**
 * Split a leading `---` fenced metadata block (local tasks: `key:`,
 * `created_at:`) from the body, and drop a first heading that repeats the
 * run title shown in the page header.
 */
export function splitTaskDescription(
  description: string,
  title?: string,
): { meta: string[]; body: string } {
  let body = description;
  let meta: string[] = [];
  const fenced = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (fenced) {
    meta = fenced[1]!.split(/\r?\n/).filter((line) => line.trim() !== "");
    body = body.slice(fenced[0].length);
  }
  body = body.replace(/^\s+/, "");
  const heading = /^#\s+(.+?)\s*(?:\r?\n|$)/.exec(body);
  if (heading && title && heading[1]!.trim() === title.trim()) {
    body = body.slice(heading[0].length).replace(/^\s+/, "");
  }
  return { meta, body };
}

export function TaskDescription({ description, title }: { description?: string; title?: string }) {
  const [expanded, setExpanded] = useState(false);

  const split = splitTaskDescription(description ?? "", title);
  if (!description || !description.trim() || !split.body.trim()) {
    return <p className="text-sm italic text-muted-foreground">No description provided.</p>;
  }

  const text = split.body;
  const truncated = !expanded && text.length > PREVIEW_LENGTH;

  return (
    <div>
      {split.meta.length > 0 ? (
        <p className="tabular mb-3 font-mono text-xs break-all text-subtle-foreground">
          {split.meta.join(" · ")}
        </p>
      ) : null}
      <div className={truncated ? "relative" : undefined}>
        <Markdown>{truncated ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text}</Markdown>
        {truncated ? (
          <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-t from-background to-transparent" />
        ) : null}
      </div>
      {text.length > PREVIEW_LENGTH ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 -ml-1"
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
          {expanded ? "show less" : `show more (${text.length - PREVIEW_LENGTH} more chars)`}
        </Button>
      ) : null}
    </div>
  );
}
