import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SourceHealthPill } from "@/components/StatusStrip";
import type { SourceHealth } from "@/lib/api";
import { attentionLabel, nextRetryAt, sourcesNeedingAttention } from "@/lib/source-health";
import { SourceHealthSection } from "@/views/AutomationsView";

const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();

function source(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    provider: "sentry",
    sourceId: "api-production",
    status: "ok",
    checkedAt: NOW - 60_000,
    lastSuccessAt: NOW - 60_000,
    consecutiveFailures: 0,
    message: null,
    retryAfterAt: null,
    ...overrides,
  };
}

function renderSection(sources: SourceHealth[]): string {
  return renderToStaticMarkup(createElement(SourceHealthSection, { sources, now: NOW }));
}

function renderPill(sources: SourceHealth[] | undefined): string {
  return renderToStaticMarkup(createElement(SourceHealthPill, { sources }));
}

test("the header counts unhealthy sources and links to Source health", () => {
  const one = renderPill([source({ status: "auth-failed" }), source({ sourceId: "web" })]);
  expect(one).toContain("1 source needs attention");
  expect(one).toContain('href="#/automations"');

  const two = renderPill([
    source({ status: "unreadable" }),
    source({ sourceId: "web", status: "rate-limited" }),
  ]);
  expect(two).toContain("2 sources need attention");
  expect(attentionLabel(3)).toBe("3 sources need attention");
});

test("no header warning when sources are healthy, absent, or from an older server", () => {
  expect(renderPill([source()])).toBe("");
  expect(renderPill([])).toBe("");
  expect(renderPill(undefined)).toBe("");
  expect(sourcesNeedingAttention(undefined)).toEqual([]);
});

test("the table lists every source with all columns once one needs attention", () => {
  const html = renderSection([
    source({
      status: "rate-limited",
      consecutiveFailures: 3,
      message: "HTTP 429",
      retryAfterAt: NOW + 10 * 60_000,
    }),
    source({ sourceId: "web-production" }),
  ]);

  for (const header of [
    "Provider",
    "Source",
    "Status",
    "Last success",
    "Failures",
    "Message",
    "Next retry",
  ]) {
    expect(html).toContain(`>${header}<`);
  }
  expect(html).toContain("Sentry");
  expect(html).toContain("api-production");
  expect(html).toContain("web-production");
  expect(html).toContain("HTTP 429");
  expect(html).toContain(`data-next-retry="${NOW + 10 * 60_000}"`);
  expect(html).toContain("in 10m");
  expect(html).toContain('id="source-health"');
});

test("each failure status renders its exact value with a distinct tone", () => {
  const statuses = ["auth-failed", "unreadable", "rate-limited"] as const;
  const badges = statuses.map((status) => {
    const html = renderSection([source({ status })]);
    expect(html).toContain(`data-source-status="${status}"`);
    expect(html).toContain(`>${status}</span>`);
    const badge = html.match(/<span[^>]*data-slot="badge"[^>]*>/)?.[0] ?? html;
    return badge;
  });
  expect(new Set(badges).size).toBe(3);
});

test("no next retry without a future retryAfterAt", () => {
  const none = renderSection([source({ status: "unreadable", retryAfterAt: null })]);
  expect(none).not.toContain("data-next-retry");

  const past = source({ status: "rate-limited", retryAfterAt: NOW - 1 });
  expect(nextRetryAt(past, NOW)).toBeNull();
  expect(renderSection([past])).not.toContain("data-next-retry");
});

test("missing values render as placeholders without breaking the row", () => {
  const html = renderSection([
    {
      provider: "sentry",
      sourceId: "never-read",
      status: "auth-failed",
      checkedAt: NOW,
      consecutiveFailures: 1,
    },
  ]);
  expect(html).toContain("never-read");
  expect(html.split(">–<").length - 1).toBe(3);
});

test("hidden with no configured sources; no success table when healthy", () => {
  expect(renderSection([])).toBe("");

  const healthy = renderSection([source()]);
  expect(healthy).not.toContain("<table");
  expect(healthy).not.toContain("text-success");
  expect(healthy).toContain("1 source reading normally");
});
