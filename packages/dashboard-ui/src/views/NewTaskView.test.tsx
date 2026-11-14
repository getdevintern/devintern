import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createTask, parseCreatedTask, TASKS_URL } from "@/lib/api";
import type { CreatedTask } from "@/lib/api";
import { NEW_TASK_HASH, parseHash, runHash } from "@/lib/routes";
import {
  emptyTaskDraft,
  MAX_TASK_BODY_CHARS,
  newIdempotencyKey,
  NewTaskForm,
  NewTaskResult,
  taskDraftError,
} from "@/views/NewTaskView";
import type { NewTaskFormProps, TaskDraft } from "@/views/NewTaskView";

const REPOS = ["backend", "web"];

function renderForm(overrides: Partial<NewTaskFormProps> = {}): string {
  return renderToStaticMarkup(
    createElement(NewTaskForm, {
      repos: REPOS,
      draft: { repo: "web", title: "Fix the flake", body: "Details" },
      onDraftChange: () => {},
      onSubmit: () => {},
      submitting: false,
      error: null,
      ...overrides,
    }),
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

test("the new-task hash routes to the form", () => {
  expect(parseHash(NEW_TASK_HASH)).toEqual({ view: "new-task" });
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

test("idempotency keys are unique per form instance", () => {
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  expect(a).toStartWith("dashboard-");
  expect(a).not.toBe(b);
});

test("the form shows the quiet-hours and PR notice, fields, and a character counter", () => {
  const html = renderForm();
  expect(html).toContain("bypass quiet hours");
  expect(html).toContain("[defaults].worker_task_args");
  expect(html).toContain("--create-pr");
  expect(html).toContain('for="new-task-repo"');
  expect(html).toContain('id="new-task-title"');
  expect(html).toContain('id="new-task-body"');
  expect(html).toContain(`7 / ${MAX_TASK_BODY_CHARS.toLocaleString("en-US")}`);
  expect(html).toContain("Enqueue task");
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

test("submitting and server errors are visible", () => {
  expect(renderForm({ submitting: true })).toContain("Enqueuing…");
  expect(renderForm({ error: 'unknown repo "mobile"' })).toContain(
    "Could not enqueue the task: unknown repo &quot;mobile&quot;",
  );
});

test("the result links to the run once it exists, else to the runs list", () => {
  const waiting = renderToStaticMarkup(
    createElement(NewTaskResult, { task: TASK, onCreateAnother: () => {} }),
  );
  expect(waiting).toContain("Enqueued <code>local-fix-the-flake</code>");
  expect(waiting).toContain('href="#/runs"');

  const started = renderToStaticMarkup(
    createElement(NewTaskResult, { task: TASK, runId: 42, onCreateAnother: () => {} }),
  );
  expect(started).toContain(`href="${runHash(42)}"`);
  expect(started).toContain("Open run #42");
});

test("a deduplicated submission says so", () => {
  const html = renderToStaticMarkup(
    createElement(NewTaskResult, {
      task: { ...TASK, deduplicated: true, status: "running" },
      onCreateAnother: () => {},
    }),
  );
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
