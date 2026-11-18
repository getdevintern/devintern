import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentPrsTable,
  AgentPrsView,
  MergedAgentPrsTable,
  sortOldestFirst,
  sortRecentlyMergedFirst,
} from "@/views/AgentPrsView";
import type { AgentPrRecord } from "@/lib/api";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function pr(overrides: Partial<AgentPrRecord> = {}): AgentPrRecord {
  return {
    repo: "acme/widgets",
    prNumber: 42,
    prUrl: "https://github.com/acme/widgets/pull/42",
    branch: "feature/dev-1",
    taskKey: "DEV-1",
    ticketUrl: "https://acme.atlassian.net/browse/DEV-1",
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

test("each open PR links to GitHub with branch, ticket, and age", () => {
  const html = renderToStaticMarkup(createElement(AgentPrsTable, { prs: [pr()], now: NOW }));

  expect(html).toContain("acme/widgets");
  expect(html).toContain("#42");
  expect(html).toContain('href="https://github.com/acme/widgets/pull/42"');
  expect(html).toContain("feature/dev-1");
  expect(html).toContain("DEV-1");
  expect(html).toContain('href="https://acme.atlassian.net/browse/DEV-1"');
  expect(html).toContain("3h");
});

test("missing branch or ticket metadata degrades to a dash", () => {
  const html = renderToStaticMarkup(
    createElement(AgentPrsTable, {
      prs: [pr({ branch: undefined, taskKey: undefined, ticketUrl: undefined })],
      now: NOW,
    }),
  );

  expect(html).toContain("#42");
  expect(html).not.toContain("feature/dev-1");
  expect(html).not.toContain("atlassian.net");
});

test("multiple PRs render one row each", () => {
  const html = renderToStaticMarkup(
    createElement(AgentPrsTable, {
      prs: [pr(), pr({ prNumber: 43, prUrl: "https://github.com/acme/widgets/pull/43" })],
      now: NOW,
    }),
  );

  expect(html).toContain("#42");
  expect(html).toContain("#43");
  expect(html).toContain("2</span> open PRs awaiting review");
});

test("oldest-waiting PR sorts first and stale ones are counted", () => {
  const old = pr({ prNumber: 7, createdAt: NOW - 9 * 24 * HOUR });
  const fresh = pr({ prNumber: 8 });
  expect(sortOldestFirst([fresh, old]).map((p) => p.prNumber)).toEqual([7, 8]);

  const html = renderToStaticMarkup(createElement(AgentPrsTable, { prs: [fresh, old], now: NOW }));
  expect(html).toContain("1 waiting over 7 days");
});

test("merged PRs render newest merge first with the merge age", () => {
  const older = pr({ prNumber: 5, mergedAt: NOW - 2 * 24 * HOUR });
  const newer = pr({ prNumber: 6, mergedAt: NOW - 2 * HOUR });
  expect(sortRecentlyMergedFirst([older, newer]).map((p) => p.prNumber)).toEqual([6, 5]);

  const html = renderToStaticMarkup(
    createElement(MergedAgentPrsTable, { prs: [older, newer], now: NOW }),
  );
  expect(html).toContain("2</span> recently merged PRs");
  expect(html).toContain("Merged");
  expect(html.indexOf("#6")).toBeLessThan(html.indexOf("#5"));
  expect(html).toContain("2h");
  expect(html).not.toContain("awaiting review");
});

test("AgentPrsView renders the Open/Merged switch", () => {
  const html = renderToStaticMarkup(createElement(AgentPrsView));
  expect(html).toContain("Open");
  expect(html).toContain("Merged");
});
