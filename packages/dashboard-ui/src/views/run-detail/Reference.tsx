import { useState } from "react";
import { ChevronDown, ChevronRight, Download, ExternalLink } from "lucide-react";

import { TaskDescription } from "@/components/TaskDescription";
import type {
  HarnessLogContent,
  HarnessLogFile,
  RunRecord,
  TaskArtifactContent,
  TaskArtifactFile,
} from "@/lib/api";
import { groupHarnessLogs } from "@/lib/harness-log-groups";
import type { HarnessLogGroup } from "@/lib/harness-log-groups";
import { Markdown } from "@/lib/markdown";
import { formatRunOriginLabel } from "@/lib/run-origin";
import { formatTime } from "@/lib/utils";
import { formatBytes, formatStageLabel, runTitle } from "./helpers";

type RowFetch<T> = {
  open: boolean;
  content: T | null;
  error: string | null;
  loading: boolean;
  toggle: () => void;
};

/** Lazy-loading toggle shared by transcript and artifact rows. */
function useLazyContent<T>(url: string, enabled = true): RowFetch<T> {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle(): Promise<void> {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content || loading || !enabled) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setContent((await response.json()) as T);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return { open, content, error, loading, toggle: () => void toggle() };
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />;
}

function RowList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {children}
    </ul>
  );
}

function TruncationNote({ totalBytes }: { totalBytes: number }) {
  return (
    <p className="mb-2 text-xs text-muted-foreground">
      Showing the first 512 KiB of {formatBytes(totalBytes)}.
    </p>
  );
}

const LOG_PRE =
  "max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-3 font-mono text-xs";

/** One harness transcript: a dense row that lazily loads its content. */
function HarnessLogItem({
  runId,
  file,
  taskKey,
}: {
  runId: number;
  file: HarnessLogFile;
  taskKey?: string;
}) {
  const { open, content, error, loading, toggle } = useLazyContent<HarnessLogContent>(
    `/api/runs/${runId}/harness-logs/${encodeURIComponent(file.name)}`,
  );

  return (
    <li>
      <button type="button" onClick={toggle} aria-expanded={open} className="rd-row">
        <Chevron open={open} />
        <span className="font-medium">{file.label ?? formatRunOriginLabel(file.origin)}</span>
        {file.taskKey && file.taskKey !== taskKey ? (
          <span className="font-mono text-xs text-muted-foreground">{file.taskKey}</span>
        ) : null}
        <span className="tabular ml-auto text-xs text-subtle-foreground">
          {file.startedAt ? formatTime(file.startedAt) : "–"} · {formatBytes(file.size)}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border bg-card px-3 py-2.5">
          {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
          {error ? <p className="text-xs text-danger">{error}</p> : null}
          {content ? (
            <>
              {content.truncated ? <TruncationNote totalBytes={content.totalBytes} /> : null}
              <pre className={LOG_PRE}>{content.content}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** One attempt's transcripts; the current run's attempt starts open. */
function AttemptGroup({
  runId,
  group,
  taskKey,
  initiallyOpen,
}: {
  runId: number;
  group: HarnessLogGroup;
  taskKey?: string;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rd-row rounded-md"
      >
        <Chevron open={open} />
        <span className="font-medium">{group.label}</span>
        {group.runId !== undefined ? (
          <span className="tabular text-xs text-subtle-foreground">run {group.runId}</span>
        ) : null}
        <span className="tabular ml-auto text-xs text-subtle-foreground">
          {group.logs.length} {group.logs.length === 1 ? "log" : "logs"}
        </span>
      </button>
      {open ? (
        <div className="mt-1 mb-2 ml-3">
          <RowList>
            {group.logs.map((file) => (
              <HarnessLogItem key={file.name} runId={runId} file={file} taskKey={taskKey} />
            ))}
          </RowList>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Every harness execution recorded for a run. The list is attributed by task
 * key as well as run id, so retries contribute earlier attempts' transcripts.
 */
function HarnessLogs({ run, logs }: { run: RunRecord; logs: HarnessLogFile[] }) {
  const { grouped, groups } = groupHarnessLogs(logs);
  if (!grouped) {
    return (
      <RowList>
        {(groups[0]?.logs ?? []).map((file) => (
          <HarnessLogItem key={file.name} runId={run.id} file={file} taskKey={run.taskKey} />
        ))}
      </RowList>
    );
  }
  // Newest attempt first: the current run is almost always what you came for.
  return (
    <div className="space-y-0.5">
      {[...groups].reverse().map((group) => (
        <AttemptGroup
          key={group.key}
          runId={run.id}
          group={group}
          taskKey={run.taskKey}
          initiallyOpen={group.runId === run.id}
        />
      ))}
    </div>
  );
}

/** One task artifact (explainer, verify output, review iteration): lazily loads content. */
function ArtifactItem({ runId, file }: { runId: number; file: TaskArtifactFile }) {
  const { open, content, error, loading, toggle } = useLazyContent<TaskArtifactContent>(
    `/api/runs/${runId}/artifacts/${file.id}`,
    file.available,
  );
  const markdown = file.mediaType === "text/markdown";
  const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mediaType);
  const fileUrl = `/api/runs/${runId}/artifacts/${file.id}/file`;

  return (
    <li>
      <button type="button" onClick={toggle} aria-expanded={open} className="rd-row">
        <Chevron open={open} />
        <span className="font-medium">{file.title}</span>
        <span className="text-xs text-muted-foreground">
          {formatStageLabel(file.step)} · execution {file.iteration}
          {file.commitSha ? ` · ${file.commitSha.slice(0, 7)}` : ""}
        </span>
        <span className="tabular ml-auto text-xs text-subtle-foreground">
          {formatTime(file.createdAt)} · {formatBytes(file.size)}
          {!file.available ? " · expired or missing" : ""}
        </span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border bg-card px-3 py-2.5">
          {file.available ? (
            <a href={`${fileUrl}?download=1`} className="ref-link text-xs">
              <Download className="size-3" aria-hidden="true" />
              Download {file.name}
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">Artifact expired or missing.</p>
          )}
          {file.publication ? (
            <p className="text-xs text-muted-foreground">
              PR publication: {file.publication.status}
              {file.publication.message ? ` — ${file.publication.message}` : ""}
              {file.publication.commentUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={file.publication.commentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ref-link"
                  >
                    View comment
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {file.upload?.status === "failed" ? (
            <p className="text-xs text-danger">Upload failed: {file.upload.message}</p>
          ) : null}
          {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
          {error ? <p className="text-xs text-danger">{error}</p> : null}
          {content ? (
            <>
              {content.truncated ? <TruncationNote totalBytes={content.totalBytes} /> : null}
              {image ? (
                <img
                  src={fileUrl}
                  alt={file.title}
                  className="max-h-96 max-w-full object-contain"
                />
              ) : markdown && content.content !== null ? (
                <Markdown>{content.content}</Markdown>
              ) : (
                <pre className={LOG_PRE}>
                  {content.content ?? "Binary artifact. Download to inspect."}
                </pre>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

type TabId = "task" | "transcripts" | "artifacts";

/** Reference material, one tab at a time: task description, transcripts, artifacts. */
export function Reference({
  run,
  logs,
  artifacts,
}: {
  run: RunRecord;
  logs: HarnessLogFile[];
  artifacts: TaskArtifactFile[];
}) {
  const tabs: { id: TabId; label: string; count?: number }[] = [];
  if (run.taskKey || run.ticketUrl) {
    tabs.push({ id: "task", label: "Task description" });
  }
  if (logs.length > 0) {
    tabs.push({ id: "transcripts", label: "Transcripts", count: logs.length });
  }
  if (artifacts.length > 0) {
    tabs.push({ id: "artifacts", label: "Artifacts", count: artifacts.length });
  }
  const [selected, setSelected] = useState<TabId | undefined>(undefined);

  if (tabs.length === 0) {
    return null;
  }
  const active = tabs.find((tab) => tab.id === selected)?.id ?? tabs[0]!.id;

  return (
    <section aria-label="Reference">
      <div role="tablist" aria-label="Reference material" className="rd-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`rd-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`rd-panel-${tab.id}`}
            onClick={() => setSelected(tab.id)}
            className="rd-tab"
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="tabular text-xs text-subtle-foreground">{tab.count}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`rd-panel-${active}`}
        aria-labelledby={`rd-tab-${active}`}
        className="pt-4"
      >
        {active === "task" ? (
          <TaskDescription description={run.taskDescription} title={runTitle(run)} />
        ) : null}
        {active === "transcripts" ? <HarnessLogs run={run} logs={logs} /> : null}
        {active === "artifacts" ? (
          <RowList>
            {artifacts.map((file) => (
              <ArtifactItem key={file.id} runId={run.id} file={file} />
            ))}
          </RowList>
        ) : null}
      </div>
    </section>
  );
}
