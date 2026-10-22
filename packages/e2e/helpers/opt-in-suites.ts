/**
 * Opt-in e2e suites that are intentionally excluded from the default local run.
 *
 * `tests/local/opt-in-suites.test.ts` turns this registry into skipped tests
 * (implemented suites) and todo entries (planned coverage), so `bun run test`
 * shows what it does not exercise instead of leaving those suites invisible.
 *
 * Keep `script` values equal to package.json script names; the local test
 * asserts every implemented (`skip`) entry still exists. Planned (`todo`)
 * entries may name a script that is added with the implementation.
 */
export interface OptInSuite {
  /** Human-readable suite name. */
  name: string;
  /** Package script that runs the suite (without the `bun run --filter` prefix). */
  script: string;
  /** Why the suite is not part of the default run. */
  reason: string;
  /** `skip` for implemented suites, `todo` for planned coverage. */
  status: "skip" | "todo";
}

export const OPT_IN_SUITES: readonly OptInSuite[] = [
  {
    name: "Live GitHub source-control E2E",
    script: "test:e2e",
    reason: "writes branches and pull requests to a fixture repository",
    status: "skip",
  },
  {
    name: "Live GitLab Self-Managed source-control E2E",
    script: "test:e2e:gitlab",
    reason: "requires the local GitLab container",
    status: "skip",
  },
  {
    name: "Bitbucket Cloud source-control E2E",
    script: "test:e2e:bitbucket",
    reason: "requires a dedicated Bitbucket fixture repository and token",
    status: "skip",
  },
  {
    name: "GitLab.com source-control E2E",
    script: "test:e2e:gitlab-com",
    reason: "requires a dedicated GitLab.com fixture project and token",
    status: "skip",
  },
  {
    name: "GitHub Issues tracker E2E",
    script: "test:e2e:tracker",
    reason: "requires a dedicated tracker repository and token",
    status: "skip",
  },
  {
    name: "Local GitLab Issues tracker E2E",
    script: "test:e2e:tracker:gitlab",
    reason: "requires the local GitLab container and a GitHub code host",
    status: "skip",
  },
  {
    name: "GitLab.com Issues tracker E2E",
    script: "test:e2e:tracker:gitlab-com",
    reason: "requires a dedicated GitLab.com project and a GitHub code host",
    status: "skip",
  },
  {
    name: "Workspace tracker smoke (read-only)",
    script: "test:trackers",
    reason: "reads the worker env and contacts Jira/Trello; no writes",
    status: "skip",
  },
  {
    name: "Jira tracker lifecycle E2E",
    script: "test:e2e:tracker:jira",
    reason: "planned in Layer 2 of docs/tracker-e2e-plan.md",
    status: "todo",
  },
  {
    name: "Trello tracker lifecycle E2E",
    script: "test:e2e:tracker:trello",
    reason: "planned in Layer 2 of docs/tracker-e2e-plan.md",
    status: "todo",
  },
  {
    name: "Linear, Asana, and Azure DevOps tracker smoke",
    script: "test:trackers",
    reason: "read-only checks are planned; the registry only detects them today",
    status: "todo",
  },
  {
    name: "Offline fake tracker servers",
    script: "test",
    reason: "planned in Layer 3 of docs/tracker-e2e-plan.md",
    status: "todo",
  },
];

/** Full command shown in skipped-test names. */
export function optInSuiteCommand(script: string): string {
  return `bun run --filter @devintern/e2e ${script}`;
}
