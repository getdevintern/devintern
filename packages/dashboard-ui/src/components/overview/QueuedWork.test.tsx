import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { cancelConfirmText, QueuedWork } from "@/components/overview/QueuedWork";
import { cancelTask, cancelTaskUrl } from "@/lib/api";
import type { CancelledTaskItem, QueuedWorkItem } from "@/lib/api";

const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const adHoc: QueuedWorkItem = {
  id: "ad-hoc:1",
  kind: "ad-hoc",
  title: "Fix the flaky test",
  taskKey: "local-fix-the-flaky-test",
  repo: "backend",
  actor: "local:add",
  createdAt: NOW - 60_000,
  notBefore: NOW + 3_600_000,
};

const retry: QueuedWorkItem = {
  id: "retry:4",
  kind: "retry",
  title: "DEV-1 retry",
  taskKey: "DEV-1",
  createdAt: NOW - 30_000,
};

function render(props: { items: QueuedWorkItem[]; cancelled?: CancelledTaskItem[] }) {
  return renderToStaticMarkup(
    createElement(QueuedWork, { total: props.items.length, now: NOW, ...props }),
  );
}

test("offers Cancel only on pending ad-hoc rows and shows the deferred time", () => {
  const html = render({ items: [adHoc, retry] });
  expect(html.match(/Cancel task/g)).toHaveLength(1);
  expect(html).toContain("local-fix-the-flaky-test");
  expect(html).toContain("Eligible");
});

test("shows the ad-hoc prompt above the Cancel control", () => {
  const html = render({
    items: [{ ...adHoc, body: "Retry the **checkout** step.", bodyTruncated: true }],
  });
  expect(html).toContain('class="aq-prompt"');
  expect(html).toContain(">checkout</strong>");
  expect(html).toContain("Prompt shortened for display.");
  expect(html.indexOf("aq-prompt")).toBeLessThan(html.indexOf("Cancel task"));
});

test("shows the detailed host-memory reason for a PR job held by memory pressure", () => {
  const html = render({
    items: [
      {
        id: "pr-job:held",
        kind: "pr-job",
        title: "CI fix on acme/web#13",
        repo: "web",
        createdAt: NOW - 1_000,
        waitingOn: "memory",
        message: "Waiting for the host to have enough free memory",
        blockReason: "only 0.4 GB of host memory is available (need 3.2 GB)",
      },
    ],
  });
  expect(html).toContain("Waiting for the host to have enough free memory");
  expect(html).toContain("only 0.4 GB of host memory is available (need 3.2 GB)");
  expect(html).toContain("<dt>Memory</dt>");
});

test("renders nothing, and no Cancel control, when nothing is queued or cancelled", () => {
  expect(render({ items: [] })).toBe("");
});

test("lists recently cancelled tasks with actor and reason, without Cancel controls", () => {
  const html = render({
    items: [],
    cancelled: [
      {
        id: "ad-hoc:2",
        taskKey: "local-dup",
        title: "Duplicate",
        repo: "backend",
        createdAt: NOW - 120_000,
        cancelledAt: NOW - 60_000,
        cancelledBy: "dashboard",
        cancelReason: "duplicate",
      },
    ],
  });
  expect(html).toContain("Nothing queued.");
  expect(html).toContain("Recently cancelled");
  expect(html).toContain("Cancelled from the dashboard");
  expect(html).toContain("duplicate");
  expect(html).not.toContain("Cancel task");
});

test("the confirmation names the task", () => {
  expect(cancelConfirmText(adHoc)).toContain("local-fix-the-flaky-test");
});

test("cancelTask posts same-origin JSON and maps outcomes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ taskKey: "local-a", outcome: "cancelled", message: "Cancelled local-a" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  expect(await cancelTask("local-a")).toEqual({
    ok: true,
    outcome: "cancelled",
    message: "Cancelled local-a",
  });
  expect(calls[0]!.url).toBe(cancelTaskUrl("local-a"));
  expect(calls[0]!.init?.method).toBe("POST");

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        taskKey: "local-a",
        outcome: "already_started",
        message: "local-a already started; it was not cancelled",
      }),
      { status: 409 },
    )) as unknown as typeof fetch;
  expect(await cancelTask("local-a")).toEqual({
    ok: false,
    outcome: "already_started",
    error: "local-a already started; it was not cancelled",
  });
});
