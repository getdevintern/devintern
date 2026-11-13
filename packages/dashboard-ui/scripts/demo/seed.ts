/**
 * Seed a throwaway workspace with a fictional "acme" demo dataset, for
 * marketing screenshots of the dashboard (see `capture.sh`).
 *
 * Writes `workspace.toml`, a dummy `.env`, and `state/queue.db` through the
 * worker's own storage classes, so the real dashboard API renders the data.
 * Timestamps are relative to "now"; re-run the script right before capturing.
 *
 * Usage: bun run scripts/demo/seed.ts <workspace-dir>
 *
 * Nothing here touches ~/.devintern or any real database.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { AutomationStateStore } from "../../../code/src/lib/automation/state";
import { RunStore } from "../../../code/src/lib/state/run-recorder";
import { WebhookQueue } from "../../../code/src/lib/state/webhook-queue";
import { WorkerState } from "../../../code/src/lib/state/worker-state";

const MIN = 60_000;
const HOUR = 60 * MIN;

const workspaceDir = process.argv[2];
if (!workspaceDir) {
  console.error("Usage: bun run scripts/demo/seed.ts <workspace-dir>");
  process.exit(1);
}
const now = Date.now();
const ago = (minutes: number): number => now - minutes * MIN;

// ---------------------------------------------------------------------------
// Workspace config (dummy credentials only)
// ---------------------------------------------------------------------------

const WORKSPACE_TOML = `[workspace]
worktrees_ttl_days = 7
dashboard = true

[workspace.execution]
isolation = "best_effort_host"
max_concurrency = 3
max_concurrency_per_repo = 1

[defaults]
worker_task_args = "--create-pr --auto-review"
poll_interval = 60
pr_labels = ["devintern"]

[[teams]]
name = "engineering"
tracker = "jira"
task_query = "project = PROJ AND labels = devintern AND statusCategory != Done"

[[teams]]
name = "product"
tracker = "linear"
task_query = '{"team":{"key":{"eq":"PRD"}}}'
repo = "web"

[[teams]]
name = "developer-tools"
tracker = "github"
task_query = "is:open label:devintern"
repo = "sdk"

[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
default_branch = "main"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
default_branch = "main"

[[repos]]
name = "infra"
remote = "git@github.com:acme/infra.git"
default_branch = "main"

[[repos]]
name = "sdk"
remote = "git@github.com:acme/sdk.git"
default_branch = "main"

[[routing.rules]]
team = "engineering"
repo = "api"
project = "PROJ"
components = ["api"]

[[routing.rules]]
team = "engineering"
repo = "infra"
project = "PROJ"
components = ["infra"]

[worker]
auto_update = true

[worker.schedule]
active = ["00:00-23:59"]
timezone = "UTC"

[[automations]]
id = "log-triage"
enabled = true
cron = "0 6 * * *"
repo = "api"
open_pr = true
allow_no_changes = true
prompt = "Review the last 24 hours of production error logs, group recurring failures, and fix the most frequent one that has a clear root cause."

[[automations]]
id = "repair-failing-main"
enabled = true
interval = "12h"
repo = "api"
open_pr = true
allow_no_changes = true
prompt = "If the latest CI run on main is red, find the failing job and open a pull request that repairs it. Make no changes when main is green."

[[automations]]
id = "dependency-updates"
enabled = true
cron = "0 9 * * 1"
repo = "web"
open_pr = true
allow_no_changes = true
prompt = "Update outdated dependencies with safe minor and patch releases, run the test suite, and open one pull request."

[[automations]]
id = "docs-drift"
enabled = true
cron = "0 10 * * 4"
repo = "web"
open_pr = true
allow_no_changes = true
prompt = "Compare the documentation with the current code and fix the pages that have drifted."

[[automations]]
id = "security-audit"
enabled = true
cron = "0 8 * * 3"
repo = "api"
open_pr = true
allow_no_changes = true
prompt = "Audit dependencies and configuration for known vulnerabilities and fix what can be fixed safely."

[[error_monitors]]
id = "api-production"
provider = "sentry"
repo = "api"
team = "engineering"
organization = "acme"
project = "api"
query = "environment:production level:error"
min_occurrences = 5
max_per_tick = 3
comment_on_action = true
`;

// Dummy values only: the dashboard shows variable names, never values.
const WORKSPACE_ENV = `AGENT_HARNESS=claude-code,codex
GITHUB_TOKEN=ghp_demo_not_a_real_token
JIRA_BASE_URL=https://acme.atlassian.net
JIRA_EMAIL=worker@acme.example
JIRA_API_TOKEN=demo_not_a_real_token
LINEAR_API_KEY=lin_api_demo_not_a_real_key
SENTRY_AUTH_TOKEN=sntrys_demo_not_a_real_token
`;

// Clear previous contents (not the directory itself: it may be a mount point).
mkdirSync(workspaceDir, { recursive: true });
for (const entry of readdirSync(workspaceDir)) {
  rmSync(join(workspaceDir, entry), { recursive: true, force: true });
}
mkdirSync(join(workspaceDir, "state"), { recursive: true });
writeFileSync(join(workspaceDir, "workspace.toml"), WORKSPACE_TOML);
writeFileSync(join(workspaceDir, ".env"), WORKSPACE_ENV, { mode: 0o600 });

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

type Harness = "claude-code" | "codex";
type Origin = "task" | "scheduled" | "pr_mention" | "ci_fix" | "error_monitor";
type Status = "succeeded" | "in_progress" | "escalated" | "failed";
type Tracker = "jira" | "linear" | "github";
type Repo = "api" | "web" | "infra" | "sdk";

interface DemoRun {
  /** Minutes ago the run started. */
  start: number;
  /** Duration in minutes (omit while in progress). */
  dur?: number;
  origin: Origin;
  status: Status;
  repo: Repo;
  harness: Harness;
  /** Ticket key (tasks) or Sentry issue key (error monitors). */
  key?: string;
  title?: string;
  tracker?: Tracker;
  automation?: string;
  pr?: number;
  /** PR is still open and waiting for review. */
  open?: boolean;
  reason?: string;
  attempt?: number;
}

const TEAM: Record<Tracker, string> = {
  jira: "engineering",
  linear: "product",
  github: "developer-tools",
};

// Cron helpers: last/next occurrence of the demo schedules (worker local time).
function matches(cron: string, date: Date): boolean {
  const [minute, hour, , , weekday] = cron.split(" ");
  return (
    Number(minute) === date.getMinutes() &&
    Number(hour) === date.getHours() &&
    (weekday === "*" || Number(weekday) === date.getDay())
  );
}
function occurrence(cron: string, direction: 1 | -1): number {
  const start = Math.floor(now / MIN) * MIN;
  for (let i = 1; i < 8 * 24 * 60; i++) {
    const t = start + direction * i * MIN;
    if (matches(cron, new Date(t))) return t;
  }
  throw new Error(`no occurrence for ${cron}`);
}
const CRONS: Record<string, string> = {
  "log-triage": "0 6 * * *",
  "dependency-updates": "0 9 * * 1",
  "docs-drift": "0 10 * * 4",
  "security-audit": "0 8 * * 3",
};

const FEATURED = "PROJ-1842";

const RUNS: DemoRun[] = [
  { start: 11, origin: "task", status: "in_progress", repo: "api", harness: "claude-code", key: "PROJ-1901", tracker: "jira", title: "Add cursor pagination to the audit log endpoint" },
  { start: 52, dur: 12, origin: "scheduled", status: "succeeded", repo: "api", harness: "claude-code", automation: "repair-failing-main", pr: 4423, open: true },
  { start: 95, dur: 31, origin: "task", status: "succeeded", repo: "web", harness: "claude-code", key: "PRD-218", tracker: "linear", title: "Show a loading skeleton on the usage dashboard", pr: 1882, open: true },
  { start: 140, dur: 26, origin: "task", status: "succeeded", repo: "infra", harness: "codex", key: "PROJ-1898", tracker: "jira", title: "Pin Terraform provider versions in the staging module", pr: 611, open: true },
  { start: 190, dur: 29, origin: "task", status: "succeeded", repo: "api", harness: "claude-code", key: FEATURED, tracker: "jira", title: "Rate limit the password reset endpoint", pr: 4419, open: true },
  { start: 235, dur: 9, origin: "pr_mention", status: "succeeded", repo: "api", harness: "claude-code", pr: 4412 },
  { start: 300, dur: 24, origin: "task", status: "succeeded", repo: "sdk", harness: "claude-code", key: "acme/sdk#58", tracker: "github", title: "Retry idempotent requests on 429 responses", pr: 92, open: true },
  { start: 335, dur: 3, origin: "task", status: "escalated", repo: "web", harness: "claude-code", key: "PRD-214", tracker: "linear", title: "Export project data as CSV", reason: "Handed back to the tracker: the ticket does not say whether archived projects belong in the export. Asked for clarification before writing any code." },
  { start: 420, dur: 18, origin: "scheduled", status: "succeeded", repo: "api", harness: "claude-code", automation: "log-triage", pr: 4415 },
  { start: 600, dur: 33, origin: "task", status: "succeeded", repo: "api", harness: "claude-code", key: "PROJ-1895", tracker: "jira", title: "Validate webhook signatures with a constant-time compare", pr: 4417 },
  { start: 690, dur: 11, origin: "ci_fix", status: "succeeded", repo: "web", harness: "codex", pr: 1877 },
  { start: 900, dur: 27, origin: "task", status: "succeeded", repo: "web", harness: "codex", key: "PRD-216", tracker: "linear", title: "Persist table column widths per user", pr: 1879 },
  { start: 1500, dur: 22, origin: "task", status: "succeeded", repo: "web", harness: "claude-code", key: "PRD-211", tracker: "linear", title: "Add keyboard shortcuts to the command palette", pr: 1874, open: true },
  { start: 1560, dur: 16, origin: "scheduled", status: "succeeded", repo: "web", harness: "claude-code", automation: "docs-drift", pr: 1873 },
  { start: 1620, dur: 14, origin: "error_monitor", status: "succeeded", repo: "api", harness: "claude-code", key: "ACME-API-4F", title: "TypeError in invoice export when customer has no billing address", pr: 4410 },
  { start: 1700, dur: 29, origin: "task", status: "succeeded", repo: "api", harness: "claude-code", key: "PROJ-1887", tracker: "jira", title: "Return 409 instead of 500 on duplicate API key names", pr: 4408 },
  { start: 1800, dur: 25, origin: "task", status: "succeeded", repo: "infra", harness: "claude-code", key: "PROJ-1883", tracker: "jira", title: "Add a CloudWatch alarm for queue depth", pr: 608 },
  { start: 1900, dur: 12, origin: "scheduled", status: "succeeded", repo: "api", harness: "claude-code", automation: "repair-failing-main", pr: 4406 },
  { start: 2100, dur: 35, origin: "task", status: "succeeded", repo: "sdk", harness: "codex", key: "acme/sdk#55", tracker: "github", title: "Expose request timeouts in the client options", pr: 90 },
  { start: 2200, dur: 21, origin: "task", status: "succeeded", repo: "web", harness: "claude-code", key: "PRD-209", tracker: "linear", title: "Fix tooltip clipping in the billing table", pr: 1870 },
  { start: 2330, dur: 17, origin: "scheduled", status: "succeeded", repo: "api", harness: "claude-code", automation: "log-triage", pr: 4401 },
  { start: 2500, dur: 38, origin: "task", status: "failed", repo: "api", harness: "codex", key: "PROJ-1879", tracker: "jira", title: "Migrate session storage to Redis", reason: "Verification failed after 3 repair attempts: integration tests require a Redis service that is not available in the worker environment." },
  { start: 2580, dur: 26, origin: "task", status: "succeeded", repo: "api", harness: "claude-code", key: "PROJ-1876", tracker: "jira", title: "Include the request id in structured error responses", pr: 4398 },
  { start: 2700, dur: 28, origin: "task", status: "succeeded", repo: "web", harness: "claude-code", key: "PRD-205", tracker: "linear", title: "Replace the legacy date picker on the reports page", pr: 1866 },
  { start: 2900, dur: 19, origin: "pr_mention", status: "succeeded", repo: "web", harness: "claude-code", pr: 1866 },
  { start: 3000, dur: 31, origin: "task", status: "succeeded", repo: "infra", harness: "claude-code", key: "PROJ-1871", tracker: "jira", title: "Rotate the staging database credentials via Secrets Manager", pr: 604 },
  { start: 3200, dur: 23, origin: "task", status: "succeeded", repo: "sdk", harness: "claude-code", key: "acme/sdk#52", tracker: "github", title: "Document pagination helpers in the README", pr: 88 },
  { start: 3300, dur: 27, origin: "task", status: "succeeded", repo: "api", harness: "claude-code", key: "PROJ-1868", tracker: "jira", title: "Add an index for the invoices.customer_id lookup", pr: 4391 },
  { start: 3500, dur: 30, origin: "task", status: "succeeded", repo: "web", harness: "codex", key: "PRD-201", tracker: "linear", title: "Make the sidebar collapsible on tablet widths", pr: 1859 },
  { start: 3650, dur: 20, origin: "ci_fix", status: "succeeded", repo: "api", harness: "claude-code", pr: 4386 },
  { start: 3800, dur: 24, origin: "task", status: "succeeded", repo: "api", harness: "claude-code", key: "PROJ-1862", tracker: "jira", title: "Paginate the list of API keys", pr: 4380 },
  { start: 4100, dur: 15, origin: "scheduled", status: "succeeded", repo: "web", harness: "claude-code", automation: "dependency-updates", pr: 1852 },
  { start: 4300, dur: 33, origin: "task", status: "succeeded", repo: "infra", harness: "claude-code", key: "PROJ-1855", tracker: "jira", title: "Move CI runners to the new base image", pr: 598 },
];

RUNS.push({ start: 0, dur: 21, origin: "scheduled", status: "succeeded", repo: "api", harness: "claude-code", automation: "security-audit", pr: 4403 });

// Cron automations ran at their real last occurrence.
for (const [id, cron] of Object.entries(CRONS)) {
  const latest = RUNS.filter((r) => r.automation === id).sort((a, b) => a.start - b.start)[0];
  if (latest) latest.start = Math.round((now - occurrence(cron, -1)) / MIN);
}

const DESCRIPTIONS: Record<string, string> = {
  [FEATURED]: `# Rate limit the password reset endpoint

\`POST /v1/auth/password-reset\` can be called without limits, so an attacker can flood a user's inbox or probe which addresses are registered.

**Acceptance criteria**

- Limit to 5 requests per hour per email address and 20 per hour per IP.
- Return \`429\` with a \`Retry-After\` header once a limit is hit.
- Respond identically whether or not the account exists.
- Cover the limits with tests.`,
};

function descriptionFor(run: DemoRun): string | undefined {
  if (run.key && DESCRIPTIONS[run.key]) return DESCRIPTIONS[run.key];
  if (!run.title) return undefined;
  return `# ${run.title}\n\nSee the ticket for context and acceptance criteria.`;
}

const ticketUrl = (run: DemoRun): string | undefined => {
  if (!run.key || !run.tracker) return undefined;
  if (run.tracker === "jira") return `https://acme.atlassian.net/browse/${run.key}`;
  if (run.tracker === "linear") return `https://linear.app/acme/issue/${run.key}`;
  const [slug, number] = run.key.split("#");
  return `https://github.com/${slug}/issues/${number}`;
};

const dbPath = join(workspaceDir, "state", "queue.db");
const store = new RunStore(dbPath);
const state = new WorkerState(dbPath);
new WebhookQueue({ dbPath }).close();
// Constructed for its side effect: it creates the automation tables.
new AutomationStateStore(dbPath).close();
const db = new Database(dbPath);

const sorted = [...RUNS].sort((a, b) => b.start - a.start);
const idByKey = new Map<string, number>();
for (const run of sorted) {
  const branch = run.key
    ? `devintern/${run.key.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`
    : run.automation
      ? `devintern/${run.automation}-${new Date(ago(run.start)).toISOString().slice(0, 10).replace(/-/g, "")}`
      : undefined;
  const id = store.createRun({
    origin: run.origin,
    taskKey: run.key,
    tracker: run.origin === "error_monitor" ? "sentry" : run.tracker,
    team: run.tracker ? TEAM[run.tracker] : undefined,
    harness: run.harness,
    branch,
    repo: `acme/${run.repo}`,
    automationId: run.automation,
    ticketUrl: ticketUrl(run),
    attempt: 1,
  });
  if (run.key) idByKey.set(run.key, id);
  const started = ago(run.start);
  const finished = run.dur === undefined ? null : started + run.dur * MIN;
  const prUrl = run.pr ? `https://github.com/acme/${run.repo}/pull/${run.pr}` : null;
  const description = descriptionFor(run);
  db.run(
    `UPDATE runs SET started_at = ?, finished_at = ?, status = ?, outcome_reason = ?,
       pr_number = ?, pr_url = ?, task_description = ?, step = ?, step_started_at = ?, step_active = ?
     WHERE id = ?`,
    [
      started,
      finished,
      run.status,
      run.reason ?? defaultReason(run),
      run.pr ?? null,
      prUrl,
      description ?? null,
      run.status === "in_progress" ? "implement" : null,
      run.status === "in_progress" ? started + 3 * MIN : null,
      run.status === "in_progress" ? 1 : 0,
      id,
    ],
  );
  seedStages(id, run, started);
  if (run.pr && run.status === "succeeded" && run.origin !== "pr_mention") {
    db.run(
      `INSERT INTO agent_prs (provider, instance_url, project_path, change_number, web_url,
         repo, pr_number, branch, task_key, ticket_url, state, created_at, updated_at)
       VALUES ('github', 'https://github.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `acme/${run.repo}`,
        run.pr,
        prUrl,
        `acme/${run.repo}`,
        run.pr,
        branch ?? null,
        run.key ?? null,
        ticketUrl(run) ?? null,
        run.open ? "open" : "closed",
        finished ?? started,
        finished ?? started,
      ],
    );
  }
}

function defaultReason(run: DemoRun): string | null {
  if (run.status !== "succeeded") return null;
  if (run.origin === "pr_mention") return "Addressed review feedback and pushed to the branch";
  if (run.origin === "ci_fix") return "Fixed the failing CI check and pushed to the branch";
  return run.pr ? `Opened pull request #${run.pr}` : null;
}

function seedStages(runId: number, run: DemoRun, started: number): void {
  const stage = (
    name: string,
    status: string,
    summary: string | null,
    at: number,
    detail?: unknown,
  ): void => {
    db.run(
      `INSERT INTO run_stages (run_id, stage, status, summary, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, name, status, summary, detail ? JSON.stringify(detail) : null, at],
    );
  };
  const dur = run.dur ?? 0;
  const at = (fraction: number): number => started + Math.round(dur * fraction * MIN);

  if (run.origin === "pr_mention" || run.origin === "ci_fix") {
    stage("change_request", "succeeded", run.pr ? `Updated pull request #${run.pr}` : null, at(0.9));
    stage("outcome", "succeeded", defaultReason(run), at(1));
    return;
  }
  if (run.status === "in_progress") {
    stage("feasibility", "succeeded", "Clear and implementable; touches the audit log service only.", started + 2 * MIN, {
      isImplementable: true,
      clarityScore: 9,
      summary: "Clear and implementable; touches the audit log service only.",
    });
    return;
  }
  if (run.status === "escalated") {
    stage("feasibility", "escalated", run.reason ?? null, at(0.9), {
      isImplementable: false,
      clarityScore: 4,
      summary: run.reason,
      recommendations: ["Confirm whether archived projects should be included in the export."],
    });
    stage("outcome", "escalated", run.reason ?? null, at(1));
    return;
  }
  const featured = run.key === FEATURED;
  stage("feasibility", "succeeded", featured ? "Clear and implementable; limits belong in the auth middleware." : "Clear and implementable.", at(0.07), {
    isImplementable: true,
    clarityScore: 9,
    summary: featured ? "Clear and implementable; limits belong in the auth middleware." : "Clear and implementable.",
  });
  stage(
    "implementation",
    run.status === "failed" ? "failed" : "succeeded",
    featured ? "Added a sliding-window limiter and wired it into the reset route." : null,
    at(0.6),
    {
      harness: run.harness,
      durationMs: Math.round(dur * 0.5 * MIN),
      report: featured
        ? "Added a sliding-window rate limiter keyed by email and IP, returned `429` with `Retry-After`, and made the response identical for unknown accounts."
        : "Implemented the change and added tests.",
    },
  );
  if (run.status === "failed") {
    stage("verify", "failed", "Integration tests could not connect to Redis.", at(0.9), {
      approved: false,
      summary: "Integration tests could not connect to Redis.",
    });
    stage("outcome", "failed", run.reason ?? null, at(1));
    return;
  }
  stage("verify", "succeeded", featured ? "Unit and integration tests pass; limits verified at the boundary." : "Tests pass.", at(0.78), {
    approved: true,
    blocking: 0,
    total: 0,
    summary: featured ? "Unit and integration tests pass; limits verified at the boundary." : "Tests pass.",
  });
  stage("auto_review", "succeeded", featured ? "Approved after 1 iteration; no blocking findings." : "Approved after 1 iteration.", at(0.94), {
    iterations: 1,
    success: true,
    finalFeedback: { summary: featured ? "Approved after 1 iteration; no blocking findings." : "Approved.", items: [] },
  });
  stage("outcome", "succeeded", defaultReason(run), at(1));
}

// Webhook deliveries waiting for the worker (PROJ-1910 is the queued ticket).
for (const [id, type] of [
  ["demo-queued-proj-1910", "jira:issue_updated"],
  ["demo-queued-prd-221", "linear:issue_updated"],
] as const) {
  db.run(
    `INSERT INTO webhook_events (id, event_type, payload, status, created_at, updated_at)
     VALUES (?, ?, '{}', 'pending', ?, ?)`,
    [id, type, ago(2), ago(2)],
  );
}

// Tracker sources polled on a 60s interval.
for (const source of ["jira:engineering", "linear:product", "github:developer-tools"]) {
  state.setCursor(source, new Date(now).toISOString());
  db.run("UPDATE cursors SET updated_at = ? WHERE source = ?", [now - 25_000, source]);
}

const lastAutomationRun = (id: string): DemoRun | undefined => RUNS.find((r) => r.automation === id);
const sixHours = 12 * HOUR;
for (const id of ["log-triage", "repair-failing-main", "dependency-updates", "docs-drift", "security-audit"]) {
  const cron = CRONS[id];
  const last = lastAutomationRun(id);
  const lastAt = last ? ago(last.start) : cron ? occurrence(cron, -1) : now - HOUR;
  const nextAt = cron ? occurrence(cron, 1) : lastAt + sixHours;
  db.run(
    `INSERT OR REPLACE INTO automation_schedules
       (automation_id, schedule_spec, last_scheduled_at, next_due_at) VALUES (?, ?, ?, ?)`,
    [id, cron ? `cron:${cron}` : "interval:12h", lastAt, nextAt],
  );
}

db.close();
store.close();
state.close();

console.log(`Seeded ${RUNS.length} runs into ${dbPath}`);
console.log(`Featured run: ${FEATURED} (run id ${idByKey.get(FEATURED)})`);
