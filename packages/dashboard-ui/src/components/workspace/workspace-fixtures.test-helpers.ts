/** Test fixtures shaped like a real `GET /api/workspace` body. */

import type { WorkspaceConfigView, WorkspaceResponse } from "@/lib/api";

export const CONFIG_PATH = "/home/dev/.devintern/workspace.toml";

export function workspaceConfig(overrides: Partial<WorkspaceConfigView> = {}): WorkspaceConfigView {
  return {
    workspace: {
      execution: { isolation: "best_effort_host", maxConcurrency: 16, maxConcurrencyPerRepo: 8 },
      worktreesTtlDays: 7,
      dashboard: true,
      ciFailureFix: true,
      conflictResolution: "scheduled",
      conflictSchedule: { cron: "0 4 * * *" },
    },
    worker: { autoUpdate: true, schedule: null },
    defaults: {
      tracker: "jira",
      taskQuery: "project = DEV AND status = 'To Do'",
      workerTaskArgs: "--create-pr --auto-review",
      prLabels: ["devintern-authored"],
      pollIntervalSeconds: 60,
    },
    sharedEnv: {
      path: "/home/dev/.devintern/.env",
      resolvedPath: "/home/dev/.devintern/.env",
      exists: true,
      keys: ["GITHUB_TOKEN", "JIRA_API_TOKEN"],
    },
    teams: [
      { name: "jira-default", tracker: "jira", taskQuery: "project = DEV", envKeys: [] },
      {
        name: "x-rep-github",
        tracker: "github",
        taskQuery: "is:open label:intern",
        repo: "x-rep",
        envFile: {
          path: "env/personal.env",
          resolvedPath: "/home/dev/.devintern/env/personal.env",
          exists: true,
          keys: ["GITHUB_TOKEN"],
        },
        envKeys: ["GITHUB_REPO"],
      },
    ],
    repos: [
      { name: "devintern", remote: "https://github.com/acme/devintern", envKeys: [] },
      { name: "x-rep", remote: "git@github.com:acme/x-rep.git", envKeys: [] },
      { name: "spare", remote: "git@gitlab.example.com:acme/spare.git", envKeys: [] },
    ],
    routing: [
      { repo: "devintern", team: "jira-default", project: "DEV", components: [], labels: [] },
    ],
    automations: [
      {
        id: "code-release",
        enabled: true,
        cron: "0 6 * * *",
        repo: "devintern",
        openPr: false,
        allowNoChanges: false,
        prompt: "You are the release manager for `@acme/code`.\n\nDecide whether to release.",
      },
      {
        id: "main-red-fixer",
        enabled: false,
        interval: "12h",
        repo: "devintern",
        openPr: true,
        allowNoChanges: true,
        prompt: "Keep main green.",
      },
    ],
    estimations: [
      { id: "weekday-groom", enabled: true, cron: "0 9 * * 1-5", query: "status = 'To Do'" },
    ],
    errorMonitors: [],
    ...overrides,
  };
}

export function okResponse(
  config: WorkspaceConfigView = workspaceConfig(),
  meta: Partial<WorkspaceResponse> = {},
): WorkspaceResponse {
  return {
    workspaceDir: "/home/dev/.devintern",
    configPath: CONFIG_PATH,
    fileModifiedAt: 1_800_000_000_000,
    workerStartedAt: 1_800_000_100_000,
    staleSinceWorkerStart: false,
    ...meta,
    status: "ok",
    config,
  } as WorkspaceResponse;
}
