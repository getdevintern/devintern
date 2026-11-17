import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  emptyTaskDraft,
  isSubmitShortcut,
  isTaskDraftDirty,
  MAX_TASK_BODY_CHARS,
  newIdempotencyKey,
  NewTaskDialog,
  NewTaskForm,
  NewTaskResult,
  taskDraftError,
} from "@/components/NewTaskDialog";
import type { NewTaskFormProps, TaskDraft } from "@/components/NewTaskDialog";
import { createTask, parseCreatedTask, TASKS_URL } from "@/lib/api";
import type { CreatedTask } from "@/lib/api";
import { parseHash, runHash } from "@/lib/routes";

const REPOS = ["backend", "web"];

function renderForm(overrides: Partial<NewTaskFormProps> = {}): string {
  return renderToStaticMarkup(
    createElement(NewTaskForm, {
      repos: REPOS,
      draft: { repo: "web", title: "Fix the flake", body: "Details" },
      onDraftChange: () => {},
      onSubmit: () => {},
      onCancel: () => {},
      submitting: false,
      error: null,
      ...overrides,
    }),
  );
}

function renderResult(task: CreatedTask, runId?: number): string {
  return renderToStaticMarkup(
    createElement(NewTaskResult, { task, runId, onCreateAnother: () => {}, onNavigate: () => {} }),
  );
}

const TASK: CreatedTask = {
  id: 7,
  taskKey: "local-fix-the-flake",
  repo: "web",
  status: "pending",
  deduplicated: false,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("New task is a dialog, not a route", () => {
  expect(parseHash("#/tasks/new")).toEqual({ view: "overview" });
  // Closed: nothing renders (the session mounts only while open).
  expect(
    renderToStaticMarkup(createElement(NewTaskDialog, { open: false, onOpenChange: () => {} })),
  ).toBe("");
});

test("a single-repo workspace preselects its repo", () => {
  expect(emptyTaskDraft(["only"]).repo).toBe("only");
  expect(emptyTaskDraft(REPOS).repo).toBe("");
});

test("draft validation requires a known repo, a title, and a body within the cap", () => {
  const ok: TaskDraft = { repo: "web", title: "x", body: "" };
  expect(taskDraftError(ok, REPOS)).toBeNull();
  expect(taskDraftError({ ...ok, repo: "" }, REPOS)).toContain("repository");
  expect(taskDraftError({ ...ok, repo: "mobile" }, REPOS)).toContain("repository");
  expect(taskDraftError({ ...ok, title: "   " }, REPOS)).toContain("title");
  expect(taskDraftError({ ...ok, body: "x".repeat(MAX_TASK_BODY_CHARS) }, REPOS)).toBeNull();
  expect(taskDraftError({ ...ok, body: "x".repeat(MAX_TASK_BODY_CHARS + 3) }, REPOS)).toContain(
    "3 characters over",
  );
});

test("a draft is dirty once it holds a title or description", () => {
  expect(isTaskDraftDirty({ repo: "web", title: "", body: "" })).toBe(false);
  expect(isTaskDraftDirty({ repo: "web", title: "  ", body: "\n" })).toBe(false);
  expect(isTaskDraftDirty({ repo: "", title: "x", body: "" })).toBe(true);
  expect(isTaskDraftDirty({ repo: "", title: "", body: "notes" })).toBe(true);
});

test("Cmd/Ctrl+Enter submits; plain Enter does not", () => {
  expect(isSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
  expect(isSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
  expect(isSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
  expect(isSubmitShortcut({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
});

test("idempotency keys are unique per dialog session", () => {
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  expect(a).toStartWith("dashboard-");
  expect(a).not.toBe(b);
});

test("the form uses the shared field components with the notice and a character counter", () => {
  const html = renderForm();
  expect(html).toContain("bypass quiet hours");
  expect(html).toContain("[defaults].worker_task_args");
  expect(html).toContain("--create-pr");
  expect(html).toContain('data-slot="field"');
  expect(html).toContain('data-slot="input"');
  expect(html).toContain('data-slot="textarea"');
  expect(html).toContain('for="new-task-repo"');
  expect(html).toContain('id="new-task-title"');
  expect(html).toContain('id="new-task-body"');
  expect(html).toContain(`7 / ${MAX_TASK_BODY_CHARS.toLocaleString("en-US")}`);
  expect(html).toContain("Enqueue task");
  expect(html).toContain("Cancel");
  expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
});

test("an incomplete or oversized draft disables submit and flags the counter", () => {
  expect(renderForm({ draft: { repo: "web", title: "", body: "" } })).toMatch(
    /<button[^>]*type="submit"[^>]*disabled/,
  );
  const over = renderForm({
    draft: { repo: "web", title: "x", body: "x".repeat(MAX_TASK_BODY_CHARS + 1) },
  });
  expect(over).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  expect(over).toContain('aria-invalid="true"');
  expect(over).toContain("text-danger");
});

test("submitting disables the inputs and Cancel", () => {
  const html = renderForm({ submitting: true });
  expect(html).toContain("Enqueuing…");
  expect(html).toMatch(/<input[^>]*id="new-task-title"[^>]*disabled/);
  expect(html).toMatch(/<textarea[^>]*disabled/);
  expect(html).toMatch(/<button[^>]*type="button"[^>]*disabled[^>]*>Cancel/);
});

test("server errors are visible", () => {
  expect(renderForm({ error: 'unknown repo "mobile"' })).toContain(
    "Could not enqueue the task: unknown repo &quot;mobile&quot;",
  );
});

test("the result links to the run once it exists, and always to the runs list", () => {
  const waiting = renderResult(TASK);
  expect(waiting).toContain("Enqueued <code>local-fix-the-flake</code>");
  expect(waiting).toContain('href="#/runs"');
  expect(waiting).toContain("Create another task");
  expect(waiting).not.toContain("Open run");

  const started = renderResult(TASK, 42);
  expect(started).toContain(`href="${runHash(42)}"`);
  expect(started).toContain("Open run #42");
  expect(started).toContain('href="#/runs"');
});

test("a deduplicated submission says so", () => {
  const html = renderResult({ ...TASK, deduplicated: true, status: "running" });
  expect(html).toContain("Already queued");
  expect(html).toContain("no duplicate");
});

test("createTask POSTs same-origin JSON and parses the result", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(TASK), { status: 201 });
  }) as unknown as typeof fetch;

  const result = await createTask({
    repo: "web",
    title: "Fix the flake",
    body: "",
    idempotencyKey: "dashboard-1",
  });
  expect(result).toEqual({ ok: true, task: TASK });
  expect(calls[0]?.url).toBe(TASKS_URL);
  expect(calls[0]?.init?.method).toBe("POST");
  expect(calls[0]?.init?.credentials).toBe("same-origin");
  expect(new Headers(calls[0]?.init?.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    repo: "web",
    title: "Fix the flake",
    body: "",
    idempotencyKey: "dashboard-1",
  });
});

test("createTask surfaces the server's error message", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "no workspace" }), {
      status: 409,
    })) as unknown as typeof fetch;
  expect(
    await createTask({ repo: "web", title: "x", body: "", idempotencyKey: "dashboard-2" }),
  ).toEqual({ ok: false, error: "no workspace" });
});

test("parseCreatedTask rejects malformed bodies", () => {
  expect(parseCreatedTask(TASK)).toEqual(TASK);
  expect(parseCreatedTask({ ...TASK, id: "7" })).toBeNull();
  expect(parseCreatedTask(null)).toBeNull();
});
