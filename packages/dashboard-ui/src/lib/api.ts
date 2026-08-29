/**
 * Types mirroring the read-only JSON API served by `devintern dashboard`
 * (packages/code/src/lib/dashboard-api.ts), plus a polling fetch hook.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type RunOrigin = "task" | "pr_mention" | "conflict_resolution" | "scheduled";

export type RunStatus =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "deferred"
  | "escalated"
  | "abandoned";

export interface RunRecord {
  id: number;
  origin: RunOrigin;
  automationId?: string;
  ticketKey?: string;
  ticketUrl?: string;
  taskKey?: string;
  tracker?: string;
  harness?: string;
  branch?: string;
  repo?: string;
  prNumber?: number;
  prUrl?: string;
  status: RunStatus;
  outcomeReason?: string;
  startedAt: number;
  finishedAt?: number;
}

/** Outcome stages carry the run's terminal status (escalated, deferred, …). */
export type StageStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "deferred"
  | "escalated"
  | "abandoned";

export interface RunStageRecord {
  id: number;
  runId: number;
  stage: "feasibility" | "implementation" | "auto_review" | "change_request" | "outcome";
  status: StageStatus;
  summary?: string;
  detail?: string;
  createdAt: number;
}

export interface RunsResponse {
  runs: RunRecord[];
  total: number;
}

export interface RunDetailResponse {
  run: RunRecord;
  stages: RunStageRecord[];
}

export interface StatsResponse {
  window: string;
  stats: {
    totals: { runs: number; byStatus: Record<RunStatus, number> };
    successRate: number | null;
    escalationRate: number | null;
    runsPerWeek: { weekStart: string; count: number }[];
    medianDurationMs: number | null;
    byHarness: {
      harness: string;
      runs: number;
      succeeded: number;
      failed: number;
      escalated: number;
      medianDurationMs: number | null;
    }[];
    byOrigin: Record<RunOrigin, number>;
  } | null;
}

export interface WorkerResponse {
  worker: { running: boolean; pid?: number; startedAt?: string } | null;
  queue: { pending: number; processing: number; failed: number };
  agentPrs: { open: number; closed: number };
  cursors: { source: string; cursorValue: string; updatedAt: number }[];
  dbPath: string;
  dbMissing: boolean;
}

export type WorkerLogLevel = "info" | "warn" | "error";

export type LogStream = "out" | "err";

export interface LogEntry {
  index: number;
  timestamp: number | null;
  level: WorkerLogLevel;
  stream: LogStream;
  message: string;
  taskKey?: string | null;
  runId?: number;
  runStatus?: RunStatus;
}

export interface LogSourceInfo {
  path: string;
  stream: LogStream;
  exists: boolean;
  totalBytes: number;
  readBytes: number;
  truncated: boolean;
  error: string;
}

export interface LogsResponse {
  available: boolean;
  entries: LogEntry[];
  sources: LogSourceInfo[];
  truncated: boolean;
}

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Fetch a JSON endpoint now and on an interval, pausing while the tab is
 * hidden. Stale responses (superseded by a newer request) are discarded.
 */
export function usePoll<T>(url: string, intervalMs = 5000): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${response.status}`);
        }
        return (await response.json()) as T;
      })
      .then((payload) => {
        if (seq === requestSeq.current) {
          setData(payload);
          setError(null);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (seq === requestSeq.current && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      });
    return controller;
  }, [url]);

  useEffect(() => {
    setLoading(true);
    let controller = load();
    const timer = setInterval(() => {
      if (!document.hidden) {
        controller.abort();
        controller = load();
      }
    }, intervalMs);
    return () => {
      clearInterval(timer);
      controller.abort();
      requestSeq.current += 1; // invalidate in-flight handlers
    };
  }, [load, intervalMs]);

  return { data, error, loading, refresh: () => void load() };
}
