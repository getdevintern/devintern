/**
 * Shared fixtures and a happy-dom harness for the notification component
 * tests: a small notification set, a fetch stub that answers list and count
 * reads with the server's filters (via the demo's in-browser filter) and
 * records every write, and click/flush helpers.
 */

import { Window } from "happy-dom";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { RunDetailResponse } from "@/lib/api";
import type { NotificationRecord } from "@/lib/api-notifications";
import { answerDemoNotifications } from "@/lib/demo-snapshot";

export const NOW = new Date(2026, 10, 25, 12, 0, 0).getTime();
const MINUTE = 60_000;

function row(overrides: Partial<NotificationRecord> & Pick<NotificationRecord, "id">) {
  return {
    kind: "escalated",
    severity: "high",
    groupKey: `group-${overrides.id}`,
    count: 1,
    title: `Notification ${overrides.id}`,
    links: [],
    createdAt: NOW - 60 * MINUTE,
    updatedAt: NOW - overrides.id * MINUTE,
    muted: false,
    ...overrides,
  } satisfies NotificationRecord;
}

export const ESCALATION_GROUP = row({
  id: 1,
  kind: "escalated",
  severity: "high",
  groupKey: "escalated:sentry:checkout",
  count: 88,
  runId: 30,
  repo: "acme/web",
  title: "Sentry issue escalated 88 times",
  links: [
    { label: "Run #30", runId: 30 },
    { label: "PRD-214", url: "https://linear.app/acme/issue/PRD-214" },
  ],
});

export const SOURCE_DOWN = row({
  id: 2,
  kind: "source_unhealthy",
  severity: "high",
  title: "linear source product: authentication failed",
  readAt: NOW - 5 * MINUTE,
});

export const WORK_SPAWNED = row({
  id: 3,
  kind: "work_spawned",
  severity: "normal",
  groupKey: "work_spawned:run:41",
  runId: 41,
  repo: "acme/docs",
  title: "Run #41 (docs-drift) delegated 2 tasks",
  body: "1/2 finished: 1 PR open",
  links: [{ label: "Run #41", runId: 41 }],
});

export const PR_OPENED = row({
  id: 4,
  kind: "pr_opened",
  severity: "normal",
  count: 3,
  title: "3 PRs opened today",
  readAt: NOW - MINUTE,
});

export const RESOLVED = row({
  id: 5,
  kind: "automation_broke",
  severity: "high",
  title: "Automation nightly broke",
  readAt: NOW - 30 * MINUTE,
  resolvedAt: NOW - 20 * MINUTE,
});

/** A grouped DevIntern-side failure (not part of {@link ALL_ROWS}). */
export const INTERNAL_ERROR = row({
  id: 6,
  kind: "internal_error",
  severity: "high",
  groupKey: "internal_error:verify:remote branch <path> not found",
  count: 3,
  runId: 953,
  repo: "acme/web",
  title: "Likely DevIntern bug: verify failed (×3)",
  body: "Remote branch refs/remotes/origin/feature/x not found\nWork saved on branch feature/y",
  links: [{ label: "Run #953", runId: 953 }],
});

export const ALL_ROWS: NotificationRecord[] = [
  ESCALATION_GROUP,
  SOURCE_DOWN,
  WORK_SPAWNED,
  PR_OPENED,
  RESOLVED,
];

export const SPAWNED_DETAIL = {
  run: { id: 41, origin: "scheduled", status: "succeeded", startedAt: NOW - 30 * MINUTE },
  stages: [],
  retry: { eligible: false, audit: [] },
  harnessLogs: [],
  artifacts: [],
  lineage: {
    parent: null,
    spawned: [
      {
        kind: "delegated_task",
        id: 7,
        taskKey: "local-document-csv",
        title: "Document the CSV export flag",
        status: "done",
        latestRunId: 44,
        latestRunStatus: "succeeded",
      },
      { kind: "delegated_task", id: 8, taskKey: "local-sdk-quickstart", status: "pending" },
    ],
  },
} as unknown as RunDetailResponse;

const DOM_GLOBALS = [
  "MutationObserver",
  "NodeFilter",
  "Element",
  "HTMLInputElement",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "KeyboardEvent",
  "PointerEvent",
  "MouseEvent",
  "ResizeObserver",
  "HTMLElement",
  "Node",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

export interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

/** A happy-dom page with a React root and a routed fetch stub. */
export class NotificationHarness {
  window: Window;
  container: HTMLElement;
  root: Root;
  calls: FetchCall[] = [];
  rows: NotificationRecord[];
  private readonly realFetch = globalThis.fetch;
  private readonly savedGlobals = new Map<string, unknown>();

  constructor(rows: NotificationRecord[] = ALL_ROWS) {
    this.rows = rows;
    this.window = new Window({ url: "http://localhost:4400/" });
    globalThis.document = this.window.document as unknown as Document;
    globalThis.window = this.window as unknown as Window & typeof globalThis.window;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    // Radix's focus scope, dismissable layer, and popper read these globals.
    for (const name of DOM_GLOBALS) {
      this.savedGlobals.set(name, (globalThis as Record<string, unknown>)[name]);
      (globalThis as Record<string, unknown>)[name] = (
        this.window as unknown as Record<string, unknown>
      )[name];
    }
    this.container = this.window.document.createElement("div") as unknown as HTMLElement;
    this.window.document.body.appendChild(this.container as never);
    this.root = createRoot(this.container);
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      this.calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
      if (method !== "GET") return Response.json({ ok: true });
      if (url === "/api/runs/41") return Response.json(SPAWNED_DETAIL);
      const answer = answerDemoNotifications(this.rows, url);
      return answer ? Response.json(answer) : Response.json({ error: "nope" }, { status: 404 });
    }) as unknown as typeof fetch;
  }

  writes(): FetchCall[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  async render(element: ReactElement): Promise<void> {
    await act(async () => {
      this.root.render(element);
      await flush();
    });
  }

  /** Everything rendered, including portals (popover, dialog) on the body. */
  get body(): HTMLElement {
    return this.window.document.body as unknown as HTMLElement;
  }

  async click(element: Element | null | undefined): Promise<void> {
    if (!element) throw new Error("element to click not found");
    await act(async () => {
      const init = { bubbles: true, cancelable: true, button: 0 };
      element.dispatchEvent(new this.window.PointerEvent("pointerdown", init) as unknown as Event);
      element.dispatchEvent(new this.window.MouseEvent("mousedown", init) as unknown as Event);
      element.dispatchEvent(new this.window.PointerEvent("pointerup", init) as unknown as Event);
      element.dispatchEvent(new this.window.MouseEvent("mouseup", init) as unknown as Event);
      element.dispatchEvent(new this.window.MouseEvent("click", init) as unknown as Event);
      await flush();
    });
  }

  button(label: string | RegExp, scope: ParentNode = this.body): HTMLElement {
    const match = [...scope.querySelectorAll("button, [role=tab], [role=checkbox]")].find((el) => {
      const name = el.getAttribute("aria-label") ?? el.textContent ?? "";
      return typeof label === "string" ? name.trim() === label : label.test(name);
    });
    if (!match) throw new Error(`button ${String(label)} not found`);
    return match as HTMLElement;
  }

  /** Titles of the rendered inbox rows, in order. */
  inboxTitles(): string[] {
    return [...this.body.querySelectorAll("li[data-notification-id] [id$='-title']")].map(
      (el) => el.textContent ?? "",
    );
  }

  async close(): Promise<void> {
    await act(async () => {
      this.root.unmount();
      await flush();
    });
    globalThis.fetch = this.realFetch;
    for (const [name, value] of this.savedGlobals) {
      if (value === undefined) delete (globalThis as Record<string, unknown>)[name];
      else (globalThis as Record<string, unknown>)[name] = value;
    }
    // @ts-expect-error test teardown
    delete globalThis.document;
    // @ts-expect-error test teardown
    delete globalThis.window;
    await this.window.happyDOM.close();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
