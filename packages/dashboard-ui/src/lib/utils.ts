import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names, resolving conflicts via `tailwind-merge`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format an epoch-ms timestamp as a compact local date-time. */
export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Clock time in the viewer's locale without a leading zero, following the
 * locale's 12/24-hour convention ("9:25 AM" or "9:25").
 */
export function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Format a duration in ms as a human-readable string (e.g. "12m 4s"). */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Format a 0..1 rate as a percentage, or a placeholder when null. */
export function formatRate(rate: number | null): string {
  return rate === null ? "–" : `${Math.round(rate * 100)}%`;
}

/** Compact relative age of an epoch-ms timestamp (e.g. "3h" for "3h ago"). */
export function formatAge(epochMs: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Relative age phrase shared by every past-time label: "just now" under a
 * minute, then "12m ago", "3h ago", "2d ago".
 */
export function formatAgo(epochMs: number, now: number = Date.now()): string {
  if (now - epochMs < 60_000) return "just now";
  return `${formatAge(epochMs, now)} ago`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Past instant: relative within a day, "Yesterday 9:25 AM", then "Nov 11, 9:25 AM". */
export function formatPastTime(epochMs: number, now: number = Date.now()): string {
  if (now - epochMs < DAY_MS) return formatAgo(epochMs, now);
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (epochMs >= startOfToday - DAY_MS && epochMs < startOfToday) {
    return `Yesterday ${formatClockTime(epochMs)}`;
  }
  return formatTime(epochMs);
}
