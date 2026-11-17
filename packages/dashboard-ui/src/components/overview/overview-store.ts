/**
 * One shared `GET /api/overview` poller for the Overview page and the status
 * strip's harness pill. Both read the same snapshot, so the pill and the
 * page's banner can never disagree, and the Overview page costs one request
 * per interval instead of two.
 */

import { useSyncExternalStore } from "react";

import { OVERVIEW_URL } from "@/lib/api";
import type { OverviewResponse } from "@/lib/api";

const INTERVAL_MS = 5000;

export interface OverviewSnapshot {
  data: OverviewResponse | null;
  error: string | null;
}

let snapshot: OverviewSnapshot = { data: null, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;

function publish(next: OverviewSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function load(): void {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  fetch(OVERVIEW_URL, { signal: current.signal })
    .then(async (response) => {
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      return (await response.json()) as OverviewResponse;
    })
    .then((data) => {
      if (controller === current) publish({ data, error: null });
    })
    .catch((cause: unknown) => {
      if (controller === current && !current.signal.aborted) {
        // Keep the last good data so a blip does not blank the page.
        publish({
          data: snapshot.data,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    load();
    timer = setInterval(() => {
      if (!document.hidden) load();
    }, INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
    }
  };
}

const getSnapshot = (): OverviewSnapshot => snapshot;

/** The shared overview snapshot, polled every 5 seconds while anything reads it. */
export function useOverviewPoll(): OverviewSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
