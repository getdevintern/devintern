/**
 * Click-through tests for the Queued list's Cancel action in a real DOM:
 * confirm inline → POST → the row disappears and the count drops, or the
 * "already started" notice shows and every queue poll is told to refresh.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { QueuedWork } from "@/components/overview/QueuedWork";
import { QUEUE_CHANGED_EVENT, usePoll } from "@/lib/api";
import type { QueuedWorkItem } from "@/lib/api";

const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const realFetch = globalThis.fetch;

let domWindow: Window;
let root: Root;
let container: HTMLElement;
let fetchCalls: Array<{ url: string; method?: string }> = [];
let queueChangedEvents = 0;

function item(id: number, taskKey: string, title: string): QueuedWorkItem {
  return {
    id: `ad-hoc:${id}`,
    kind: "ad-hoc",
    title,
    taskKey,
    repo: "acme/backend",
    actor: "local:add",
    createdAt: NOW - 60_000,
  };
}

const first = item(1, "local-first", "First task");
const second = item(2, "local-second", "Second task");

function stubFetch(status: number, payload: unknown): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderQueue(items: QueuedWorkItem[]): Promise<void> {
  await act(async () => {
    root.render(createElement(QueuedWork, { items, total: items.length, now: NOW }));
    await flush();
  });
}

function rows(): string[] {
  return [...container.querySelectorAll(".aq-item .aq-title")].map((el) => el.textContent ?? "");
}

function count(): string | null | undefined {
  return container.querySelector(".aw-count")?.textContent;
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new domWindow.MouseEvent("click", { bubbles: true }) as unknown as Event,
    );
    await flush();
  });
}

function confirmation(): Element | null {
  return container.querySelector(".aq-confirm");
}

/** Answer the inline confirmation: confirm the cancel, or keep the task. */
async function answerConfirmation(confirm: boolean): Promise<void> {
  const box = confirmation();
  expect(box?.textContent).toContain("Cancel this task?");
  const button = confirm
    ? box?.querySelector("[data-confirm-cancel]")
    : [...(box?.querySelectorAll("button") ?? [])].find((el) => el.textContent === "Keep task");
  await click(button as Element | undefined);
}

async function clickCancel(taskTitle: string): Promise<void> {
  const row = [...container.querySelectorAll(".aq-item")].find((el) =>
    el.querySelector(".aq-title")?.textContent?.includes(taskTitle),
  );
  const button = [...(row?.querySelectorAll("button") ?? [])].find((el) =>
    el.textContent?.includes("Cancel task"),
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await flush();
  });
}

beforeEach(() => {
  domWindow = new Window({ url: "http://localhost:4400/" });
  globalThis.document = domWindow.document as unknown as Document;
  globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  fetchCalls = [];
  queueChangedEvents = 0;
  domWindow.addEventListener(QUEUE_CHANGED_EVENT, () => {
    queueChangedEvents += 1;
  });
  container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.appendChild(container as never);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await flush();
  });
  globalThis.fetch = realFetch;
  // @ts-expect-error test teardown
  delete globalThis.document;
  // @ts-expect-error test teardown
  delete globalThis.window;
  await domWindow.happyDOM.close();
});

test("confirmed cancel removes the row, drops the count, and refreshes the queue polls", async () => {
  stubFetch(200, {
    taskKey: "local-first",
    outcome: "cancelled",
    message: "Cancelled local-first",
  });
  await renderQueue([first, second]);
  expect(rows()).toEqual(["First task", "Second task"]);
  expect(count()).toBe("2");

  await clickCancel("First task");
  expect(confirmation()?.textContent).toContain('"First task" (local-first) will not run');
  expect(fetchCalls).toEqual([]);
  await answerConfirmation(true);

  expect(confirmation()).toBeNull();
  expect(fetchCalls).toEqual([{ url: "/api/tasks/local-first/cancel", method: "POST" }]);
  expect(rows()).toEqual(["Second task"]);
  expect(count()).toBe("1");
  expect(queueChangedEvents).toBe(1);
});

test("a task the worker already started shows the notice, stays listed, and refreshes", async () => {
  stubFetch(409, {
    taskKey: "local-first",
    outcome: "already_started",
    message: "local-first already started; it was not cancelled",
  });
  await renderQueue([first, second]);

  await clickCancel("First task");
  await answerConfirmation(true);

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("already started");
  expect(rows()).toEqual(["First task", "Second task"]);
  expect(count()).toBe("2");
  expect(queueChangedEvents).toBe(1);
});

test("keeping the task in the confirmation sends nothing", async () => {
  stubFetch(200, {});
  await renderQueue([first]);

  await clickCancel("First task");
  await answerConfirmation(false);

  expect(confirmation()).toBeNull();
  expect(fetchCalls).toEqual([]);
  expect(rows()).toEqual(["First task"]);
  expect(queueChangedEvents).toBe(0);
});

test("a poll with refreshOn re-fetches at once when the queue changes", async () => {
  let workerFetches = 0;
  globalThis.fetch = (async () => {
    workerFetches += 1;
    return new Response(JSON.stringify({ pending: workerFetches }), { status: 200 });
  }) as unknown as typeof fetch;
  function Probe() {
    const { data } = usePoll<{ pending: number }>("/api/worker", 60_000, {
      refreshOn: QUEUE_CHANGED_EVENT,
    });
    return createElement("span", { id: "probe" }, data ? String(data.pending) : "");
  }
  await act(async () => {
    root.render(createElement(Probe));
    await flush();
  });
  expect(workerFetches).toBe(1);

  await act(async () => {
    domWindow.dispatchEvent(new domWindow.Event(QUEUE_CHANGED_EVENT));
    await flush();
  });
  expect(workerFetches).toBe(2);
  expect(container.querySelector("#probe")?.textContent).toBe("2");
});

test("re-queueing a failed dependency posts the run retry and refreshes the queue", async () => {
  stubFetch(202, { status: "requeued" });
  const dependent: QueuedWorkItem = {
    ...item(3, "local-dependent", "Dependent task"),
    dependsOn: ["local-first"],
    dependencyState: "blocked",
    dependencyReason: "local-first failed",
    dependencyLinks: [
      {
        key: "local-first",
        status: "failed",
        latestRunId: 12,
        latestRunStatus: "abandoned",
        retryKind: "injected",
      },
    ],
  };
  await renderQueue([dependent]);

  await click(container.querySelector('[data-dependency-retry="local-first"]'));
  expect(fetchCalls).toEqual([]);
  const confirm = [...container.querySelectorAll("button")].find(
    (el) => el.textContent === "Re-queue task",
  );
  await click(confirm);

  expect(fetchCalls).toEqual([{ url: "/api/runs/12/retry", method: "POST" }]);
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Re-queued. The worker will resume local-first",
  );
  expect(container.querySelector("[data-dependency-retry]")).toBeNull();
  expect(queueChangedEvents).toBe(1);
});
