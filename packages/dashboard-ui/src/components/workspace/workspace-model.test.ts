import { describe, expect, test } from "bun:test";

import {
  buildWorkspaceFlow,
  collectEnvSources,
  collectIssues,
  countFlowCrossings,
  conflictLabel,
  describeFlow,
  describeRemote,
  formatSeconds,
  orderFlowRepos,
  promptPreview,
  routeLabel,
  ruleCriteria,
  scheduleLabel,
  workingHoursLabel,
} from "@/components/workspace/workspace-model";
import type { FlowSource } from "@/components/workspace/workspace-model";
import { workspaceConfig } from "@/components/workspace/workspace-fixtures.test-helpers";

describe("buildWorkspaceFlow", () => {
  test("maps rule-routed and fixed-repo teams to their repos", () => {
    const flow = buildWorkspaceFlow(workspaceConfig());
    const jira = flow.sources.find((source) => source.id === "team:jira-default");
    const github = flow.sources.find((source) => source.id === "team:x-rep-github");
    expect(jira?.badge).toBe("Jira");
    expect(jira?.routes).toEqual([
      { kind: "rule", repo: "devintern", known: true, criteria: ["project DEV"], scoped: true },
    ]);
    expect(github?.badge).toBe("GitHub");
    expect(github?.routes).toEqual([{ kind: "fixed", repo: "x-rep", known: true }]);
  });

  test("splits automations per repo into enabled and disabled rows", () => {
    const flow = buildWorkspaceFlow(workspaceConfig());
    const groups = flow.sources.filter((source) => source.kind === "automations");
    expect(groups.map((group) => [group.title, group.disabled])).toEqual([
      ["1 automation", false],
      ["1 disabled automation", true],
    ]);
    expect(groups[1]?.routes).toEqual([{ kind: "fixed", repo: "devintern", known: true }]);
  });

  test("orders repos by the mean row of their sources so wires cross least; idle repos last", () => {
    const flow = buildWorkspaceFlow(workspaceConfig());
    // Rows: 0 jira→devintern, 1 github→x-rep, 2-3 automations→devintern.
    expect(flow.repos.map((repo) => [repo.name, repo.inbound])).toEqual([
      ["x-rep", 1],
      ["devintern", 3],
      ["spare", 0],
    ]);
  });

  test("repo order minimises wire crossings and is deterministic", () => {
    const source = (id: string, repos: string[]): FlowSource => ({
      id,
      kind: "team",
      title: id,
      badge: "Jira",
      routes: repos.map((repo) => ({ kind: "fixed", repo, known: true })),
      envMissing: false,
      disabled: false,
    });
    // Barycenters tie (a: 1.5, b: 1.5, c: 1.5), so a naive order crosses wires.
    const sources = [source("s0", ["a", "c"]), source("s1", ["b"]), source("s2", ["a", "c"])];
    const config = workspaceConfig({
      repos: ["c", "b", "a"].map((name) => ({ name, remote: `git@x:${name}.git`, envKeys: [] })),
    });
    const ordered = orderFlowRepos(config, sources).map((repo) => repo.name);
    const all = [
      ["a", "b", "c"],
      ["a", "c", "b"],
      ["b", "a", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
      ["c", "b", "a"],
    ];
    const optimum = Math.min(...all.map((order) => countFlowCrossings(sources, order)));
    expect(countFlowCrossings(sources, ordered)).toBe(optimum);
    expect(countFlowCrossings(sources, ordered)).toBeLessThan(
      countFlowCrossings(sources, ["c", "b", "a"]),
    );
    expect(orderFlowRepos(config, sources).map((repo) => repo.name)).toEqual(ordered);
    // Straight-through order has no crossings.
    const straight = [source("s0", ["a"]), source("s1", ["b"])];
    expect(countFlowCrossings(straight, ["a", "b"])).toBe(0);
    expect(countFlowCrossings(straight, ["b", "a"])).toBe(1);
  });

  test("the generated summary names every destination for screen readers", () => {
    const summary = describeFlow(buildWorkspaceFlow(workspaceConfig()));
    expect(summary).toContain(
      "jira-default (Jira) sends project DEV to devintern; otherwise its tasks are skipped.",
    );
    expect(summary).toContain("x-rep-github (GitHub) sends all tasks to x-rep.");
    expect(summary).toContain("1 disabled automation is paused (targets devintern).");
    expect(summary).toContain("spare receives no routed work, only ad-hoc tasks.");
  });

  test("team rules follow the worker: scoped to the team or unscoped, never another team's", () => {
    const config = workspaceConfig({
      routing: [
        { repo: "devintern", team: "other-team", project: "OPS", components: [], labels: [] },
        { repo: "spare", labels: ["infra", "ops"], components: ["api"], project: undefined },
      ],
    });
    const jira = buildWorkspaceFlow(config).sources.find((s) => s.id === "team:jira-default");
    expect(jira?.routes).toEqual([
      {
        kind: "rule",
        repo: "spare",
        known: true,
        criteria: ["labels infra, ops", "component api"],
        scoped: false,
      },
    ]);
  });

  test("fallthrough follows the worker router: skipped with several repos, only repo with one", () => {
    const multi = buildWorkspaceFlow(workspaceConfig());
    expect(multi.sources.find((s) => s.id === "team:jira-default")?.fallthrough).toEqual({
      kind: "skipped",
    });
    // A fixed-repo team never falls through.
    expect(multi.sources.find((s) => s.id === "team:x-rep-github")?.fallthrough).toBeUndefined();
    const single = buildWorkspaceFlow(
      workspaceConfig({
        teams: [],
        repos: [{ name: "solo", remote: "git@github.com:acme/solo.git", envKeys: [] }],
        routing: [{ repo: "solo", labels: ["backend"], components: [] }],
        automations: [],
      }),
    );
    expect(single.sources[0]?.fallthrough).toEqual({ kind: "repo", repo: "solo" });
  });

  test("disabled automation rows read as paused", () => {
    const flow = buildWorkspaceFlow(workspaceConfig());
    const paused = flow.sources.find((source) => source.disabled && source.kind === "automations");
    expect(paused && routeLabel(paused.routes[0]!, paused.kind, paused.disabled)).toBe("paused");
  });

  test("a one-repo workspace routes everything to the only repo", () => {
    const config = workspaceConfig({
      teams: [],
      routing: [],
      repos: [{ name: "solo", remote: "git@github.com:acme/solo.git", envKeys: [] }],
      automations: [],
    });
    const flow = buildWorkspaceFlow(config);
    expect(flow.sources).toHaveLength(1);
    expect(flow.sources[0]?.kind).toBe("defaults");
    expect(flow.sources[0]?.routes).toEqual([{ kind: "only", repo: "solo", known: true }]);
  });

  test("a team with no applicable rule in a multi-repo workspace is unrouted", () => {
    const flow = buildWorkspaceFlow(workspaceConfig({ routing: [] }));
    const jira = flow.sources.find((source) => source.id === "team:jira-default");
    expect(jira?.routes).toEqual([{ kind: "unrouted" }]);
    expect(routeLabel({ kind: "unrouted" })).toBe("No route");
    expect(routeLabel({ kind: "fixed", repo: "x", known: true }, "team")).toBe("all tasks");
    expect(routeLabel({ kind: "fixed", repo: "x", known: true }, "monitor")).toBe("every issue");
  });

  test("error monitors land in their mapped repo and flag missing env files", () => {
    const config = workspaceConfig({
      errorMonitors: [
        {
          id: "sentry-main",
          provider: "sentry",
          enabled: false,
          repo: "devintern",
          intervalSeconds: 60,
          minOccurrences: 5,
          maxIssuesPerTick: 3,
          commentOnAction: true,
          organization: "acme",
          project: "web",
          envFile: {
            path: "env/sentry.env",
            resolvedPath: "/x/env/sentry.env",
            exists: false,
            keys: [],
          },
          envKeys: [],
        },
      ],
    });
    const monitor = buildWorkspaceFlow(config).sources.find((s) => s.kind === "monitor");
    expect(monitor?.badge).toBe("Sentry");
    expect(monitor?.disabled).toBe(true);
    expect(monitor?.envMissing).toBe(true);
    expect(monitor?.note).toBe("project acme/web");
  });
});

describe("labels", () => {
  test("schedules read as human text with the raw value kept", () => {
    expect(scheduleLabel({ cron: "0 6 * * *" })).toEqual({
      label: "Daily 06:00",
      raw: "0 6 * * *",
    });
    expect(scheduleLabel({ cron: "0 9 * * 1-5" }).label).toBe("Weekdays 09:00");
    expect(scheduleLabel({ cron: "0 8 * * 1" }).label).toBe("Mondays 08:00");
    // Intervals carry no extra information in their raw form.
    expect(scheduleLabel({ interval: "12h" })).toEqual({ label: "Every 12h" });
    expect(scheduleLabel({ cron: "5 4 1-7 * 1" })).toEqual({ label: "5 4 1-7 * 1" });
    expect(scheduleLabel(undefined)).toEqual({ label: "–" });
  });

  test("rule criteria fall back to any task", () => {
    expect(ruleCriteria({ repo: "a", components: [], labels: [] })).toEqual(["any task"]);
  });

  test("remotes become owner/repo labels with browsable links", () => {
    expect(describeRemote("git@github.com:acme/x-rep.git")).toEqual({
      label: "acme/x-rep",
      href: "https://github.com/acme/x-rep",
    });
    expect(describeRemote("https://github.com/acme/devintern")).toEqual({
      label: "acme/devintern",
      href: "https://github.com/acme/devintern",
    });
    expect(describeRemote("git@gitlab.example.com:acme/spare.git")).toEqual({
      label: "gitlab.example.com/acme/spare",
      href: undefined,
    });
    expect(describeRemote("/srv/git/local")).toEqual({ label: "/srv/git/local" });
  });

  test("policy labels", () => {
    expect(conflictLabel("scheduled", { cron: "0 4 * * *" })).toBe("Scheduled · Daily 04:00");
    expect(conflictLabel("auto", undefined)).toBe("Automatic");
    expect(conflictLabel("disabled", undefined)).toBe("Off");
    expect(formatSeconds(60)).toBe("1m");
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(7200)).toBe("2h");
    expect(workingHoursLabel(null)).toEqual({ label: "Any time" });
    expect(
      workingHoursLabel({
        active: [{ spec: "22:00-07:00", startMinutes: 1320, endMinutes: 420 }],
        blocked: [{ spec: "02:00-03:00", startMinutes: 120, endMinutes: 180 }],
        timezone: "Europe/Berlin",
        catchUpMissed: false,
      }),
    ).toEqual({ label: "22:00–07:00", detail: "paused 02:00–03:00 · Europe/Berlin" });
  });

  test("prompt previews drop markdown markers", () => {
    expect(promptPreview("\n## Release `@acme/code` **now**\nmore")).toBe("Release @acme/code now");
    expect(promptPreview("- see [docs](https://x.dev)")).toBe("see docs");
  });
});

describe("credentials and issues", () => {
  test("env sources list shared, then teams/repos/monitors that set env", () => {
    const sources = collectEnvSources(workspaceConfig());
    expect(sources.map((source) => source.id)).toEqual(["shared", "team:x-rep-github"]);
    expect(sources[1]?.inlineKeys).toEqual(["GITHUB_REPO"]);
  });

  test("missing env files, unrouted teams, and unknown repos are reported", () => {
    const config = workspaceConfig({ routing: [] });
    const team = config.teams[1];
    if (team?.envFile) team.envFile = { ...team.envFile, exists: false, keys: [] };
    config.sharedEnv = { ...config.sharedEnv, exists: false, keys: [] };
    config.automations = [{ ...config.automations[0]!, repo: "ghost" }];
    const issues = collectIssues(config, buildWorkspaceFlow(config));
    expect(issues.map((issue) => issue.message)).toEqual([
      "x-rep-github: env file env/personal.env is missing",
      "jira-default: no routing rule or repo, so its tasks are skipped",
      'Automation code-release: runs in "ghost", which is not a configured repo',
    ]);
  });
});
