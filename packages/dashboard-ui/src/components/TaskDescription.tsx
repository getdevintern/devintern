import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Markdown } from "@/lib/markdown";

/**
 * Characters shown before a long description is collapsed behind a toggle.
 * Generous enough to keep most tickets fully visible without any interaction;
 * long transcripts of HTML-converted content degrade to a preview instead of
 * pushing the stage timeline off screen.
 */
const PREVIEW_LENGTH = 1500;

/**
 * The ticket's original task description, rendered as markdown so it is
 * clearly distinguished from agent-generated step summaries. Blank
 * descriptions (tickets with no body) get an explicit placeholder rather
 * than an empty card body; callers hide the whole section for non-ticket
 * runs (PR mentions, conflict resolutions) by not rendering it at all.
 */
export function TaskDescription({ description }: { description?: string }) {
  const [expanded, setExpanded] = useState(false);

  if (!description || !description.trim()) {
    return <p className="text-sm italic text-muted-foreground">No description provided.</p>;
  }

  const truncated = !expanded && description.length > PREVIEW_LENGTH;

  return (
    <div>
      <div className={truncated ? "relative" : undefined}>
        <Markdown>
          {truncated ? `${description.slice(0, PREVIEW_LENGTH).trimEnd()}…` : description}
        </Markdown>
        {truncated ? (
          <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-t from-background to-transparent" />
        ) : null}
      </div>
      {description.length > PREVIEW_LENGTH ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="-ml-1 text-muted-foreground"
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {expanded ? "show less" : `show more (${description.length - PREVIEW_LENGTH} more chars)`}
        </Button>
      ) : null}
    </div>
  );
}
