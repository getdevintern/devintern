import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceScreen } from "@/views/WorkspaceView";
import type { WorkspaceResponse } from "@/lib/api";
import {
  CONFIG_PATH,
  okResponse,
  workspaceConfig,
} from "@/components/workspace/workspace-fixtures.test-helpers";

function render(response: WorkspaceResponse): string {
  return renderToStaticMarkup(createElement(WorkspaceScreen, { response }));
}

test("missing config points at the setup commands and the docs", () => {
  const html = render({
    workspaceDir: "/home/dev/.devintern",
    configPath: CONFIG_PATH,
    status: "missing",
    error: "No workspace config",
  });
  expect(html).toContain("No workspace config yet");
  expect(html).toContain("devintern worker init");
  expect(html).toContain("devintern worker add-repo");
  expect(html).toContain(CONFIG_PATH);
  expect(html).toContain("https://devintern.com/docs/code/workspaces");
});

test("invalid config lists every problem and explains the running worker keeps its config", () => {
  const html = render({
    workspaceDir: "/home/dev/.devintern",
    configPath: CONFIG_PATH,
    workerStartedAt: 1,
    status: "invalid",
    error: `Invalid ${CONFIG_PATH}`,
    problems: [
      '[[teams]] "a".repo "b" does not match any [[repos]] name.',
      "max_concurrency must be positive",
    ],
  });
  expect(html).toContain("workspace.toml has 2 problems");
  expect(html).toContain("<li>max_concurrency must be positive</li>");
  expect(html).toContain("keeps its last valid config");
});

test("invalid config without a running worker says the worker will not start", () => {
  const html = render({
    workspaceDir: "/home/dev/.devintern",
    configPath: CONFIG_PATH,
    status: "invalid",
    error: "Failed to parse workspace.toml: unexpected token",
    problems: [],
  });
  expect(html).toContain("workspace.toml is invalid");
  expect(html).toContain("will not start");
  expect(html).toContain("Failed to parse workspace.toml");
});

test("ok config renders the flow, repos, automations, credentials, and policy sections in order", () => {
  const html = render(okResponse());
  const order = [
    "ws-flow",
    "ws-repos",
    "ws-automations",
    "ws-estimations",
    "ws-credentials",
    "ws-execution",
  ].map((id) => html.indexOf(`id="${id}"`));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).toContain("project DEV");
  expect(html).toContain("all tasks");
  expect(html).toContain("Daily 06:00");
  expect(html).toContain("Every 12h");
  expect(html).toContain('href="#/automations/code-release"');
  // Error monitors are omitted when none are configured.
  expect(html).not.toContain('id="ws-monitors"');
  // Prompts start collapsed: preview only, no full markdown body.
  expect(html).toContain("You are the release manager for @acme/code.");
  expect(html).not.toContain("Decide whether to release.");
  expect(html).toContain("Disabled");
});

test("rail counts match the sections and the diagram's automation rows", () => {
  const html = render(okResponse());
  expect(html).toContain('<span>Automations</span><span class="tabular">2</span>');
  expect(html).toContain('<span>Estimations</span><span class="tabular">1</span>');
  expect(html).toContain("1 automation");
  expect(html).toContain("1 disabled automation");
});

test("route chips carry their destination for screen readers, and the diagram has a summary", () => {
  const html = render(okResponse());
  expect(html).toMatch(
    /all tasks<\/span><span class="wsf-route-target">.*?to<\/span><span class="wsf-route-repo">x-rep</,
  );
  expect(html).toContain('aria-describedby="');
  expect(html).toContain("x-rep-github (GitHub) sends all tasks to x-rep.");
  // Without measured wires (SSR, below the diagram breakpoint) rows are not tab stops.
  expect(html).not.toContain('tabindex="0"');
  expect(html).toContain("No routes into");
  // Rule-routed teams show what happens to unmatched tasks.
  expect(html).toContain("otherwise skipped");
  // Sections take focus from the rail.
  expect(html).toContain('class="ws-section" tabindex="-1"');
});

test("a rejected reload shows the reason and the startup-only keys", () => {
  const html = render(
    okResponse(workspaceConfig(), {
      staleSinceWorkerStart: true,
      configSync: "rejected",
      appliedConfig: {
        appliedAt: 1_800_000_000_000,
        fileModifiedAt: 1_800_000_000_000,
        rejectedReason: "[defaults].tracker is startup-only; restart the worker to change it.",
        rejectedAt: 1_800_000_200_000,
      },
    }),
  );
  expect(html).toContain("The worker rejected the latest save");
  expect(html).toContain("[defaults].tracker is startup-only; restart the worker to change it.");
  expect(html).toContain("A reload is all-or-nothing.");
  expect(html).toContain("name, tracker, env_file, inline env, or adding/removing a team");
  expect(html).toContain("[worker.schedule]");
  expect(html).not.toContain("Fix the error in workspace.toml");
});

test("a rejection that is not a startup-only change shows the reason and a fix hint", () => {
  const reason =
    "task_query cannot be enabled live because the jira change detector could not be initialized.";
  const html = render(
    okResponse(workspaceConfig(), {
      staleSinceWorkerStart: true,
      configSync: "rejected",
      appliedConfig: {
        appliedAt: 1_800_000_000_000,
        fileModifiedAt: 1_800_000_000_000,
        rejectedReason: reason,
        rejectedAt: 1_800_000_200_000,
      },
    }),
  );
  expect(html).toContain("The worker rejected the latest save");
  expect(html).toContain("task_query cannot be enabled live");
  expect(html).toContain(
    "Fix the error in workspace.toml and save again; the worker keeps running the last valid config.",
  );
  expect(html).not.toContain("A reload is all-or-nothing.");
  expect(html).not.toContain("ws-startup-keys");
});

test("an applied hot reload shows no stale warning even though the file is newer", () => {
  const html = render(
    okResponse(workspaceConfig(), {
      staleSinceWorkerStart: true,
      configSync: "applied",
      appliedConfig: { appliedAt: 1_800_000_200_000, fileModifiedAt: 1_800_000_150_000 },
    }),
  );
  expect(html).toContain("Worker is running this version");
  expect(html).not.toContain("rejected the latest save");
  expect(html).not.toContain("applied the latest save yet");
});

test("pending and unconfirmed states are quiet, not warnings", () => {
  const pending = render(okResponse(workspaceConfig(), { configSync: "pending" }));
  expect(pending).toContain("applied the latest save yet");
  expect(pending).toContain("ws-callout-info");
  const unconfirmed = render(okResponse(workspaceConfig(), { configSync: "unconfirmed" }));
  expect(unconfirmed).toContain("confirm the worker applied this version");
  expect(unconfirmed).not.toContain("ws-callout-warning");
  // Visible text, not just a tooltip.
  expect(unconfirmed).toContain("it predates reload tracking");
});

test("a missing env file shows as a warning, with key names but never values", () => {
  const config = workspaceConfig();
  const team = config.teams[1];
  if (team?.envFile) team.envFile = { ...team.envFile, exists: false, keys: [] };
  const html = render(okResponse(config));
  expect(html).toContain("1 thing needs attention");
  expect(html).toContain("x-rep-github: env file env/personal.env is missing");
  expect(html).toContain("GITHUB_REPO");
  expect(html).toContain("Env file missing");
});

test("an empty workspace explains how to add automations", () => {
  const config = workspaceConfig({
    teams: [],
    routing: [],
    automations: [],
    estimations: [],
    repos: [{ name: "solo", remote: "git@github.com:acme/solo.git", envKeys: [] }],
  });
  const html = render(okResponse(config));
  expect(html).toContain("Default poller");
  expect(html).toContain("all tasks");
  expect(html).toContain("No automations configured");
});

test("a workspace without repos shows a setup hint instead of the diagram", () => {
  const html = render(
    okResponse(workspaceConfig({ teams: [], routing: [], repos: [], automations: [] })),
  );
  expect(html).toContain("Nothing to route yet");
  expect(html).toContain("No repositories yet");
});

test("every in-page link goes through SectionLink, so none can replace the hash route", () => {
  const config = workspaceConfig({
    teams: [{ name: "lost", tracker: "jira", taskQuery: "project = X", envKeys: [] }],
    repos: [
      {
        name: "devintern",
        remote: "https://github.com/acme/devintern",
        envFile: {
          path: "env/x.env",
          resolvedPath: "/nope/x.env",
          exists: false,
          keys: [],
        },
        envKeys: ["A"],
      },
      { name: "spare", remote: "git@gitlab.example.com:acme/spare.git", envKeys: [] },
    ],
    routing: [],
  });
  const html = render(okResponse(config));
  const anchors = [...html.matchAll(/<a\b[^>]*href="#ws-[^"]*"[^>]*>/g)].map((match) => match[0]);
  // Section rail, attention issues, idle repo, and Env column links.
  expect(anchors.length).toBeGreaterThan(8);
  for (const tag of anchors) expect(tag).toContain("data-section-link");
  // No bare hash links to section ids anywhere else in the page source.
  expect(html).not.toMatch(/<a\b(?![^>]*data-section-link)[^>]*href="#ws-/);
});

test("SectionLink prevents navigation and scrolls instead", async () => {
  const { SectionLink } = await import("@/components/workspace/SectionLink");
  const element = SectionLink({ to: "ws-credentials", children: "x" });
  let prevented = false;
  let scrolled = false;
  const target = {
    scrollIntoView: () => (scrolled = true),
    focus: () => undefined,
  };
  const previous = globalThis.document;
  // oxlint-disable-next-line typescript/no-explicit-any -- minimal DOM stub
  (globalThis as any).document = { getElementById: () => target };
  try {
    element.props.onClick({
      defaultPrevented: false,
      preventDefault: () => (prevented = true),
    });
  } finally {
    (globalThis as any).document = previous;
  }
  expect(prevented).toBe(true);
  expect(scrolled).toBe(true);
  expect(element.props.href).toBe("#ws-credentials");
});
