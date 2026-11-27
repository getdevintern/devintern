/**
 * The wizard's last offer once the worker runs: a sample first task, so the
 * user watches a run start instead of going back to the tracker to label a
 * ticket and guess whether it worked.
 *
 * - GitHub and GitLab: create a small docs-only issue carrying the labels the
 *   saved query selects on (`label:<x>`), after a `[Y/n]` question.
 * - Markdown: write a sample task file into `MARKDOWN_TASKS_DIR` with the
 *   frontmatter the query filters on (`status=todo`).
 * - Any other tracker: queue the same task with `devintern worker add`.
 *
 * Then it polls the worker's run list for that task for a bounded time and
 * prints the dashboard link to the run. Declining creates nothing. Flags mode
 * never creates anything: it lists the `try-first-task` next step
 * ({@link sampleTaskAddCommand}) instead.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { GitHubClient, GitLabClient, sanitizeGitlabBaseUrl } from "@devintern/task-trackers";

import { shellQuote, workspaceEnvPrefixFor } from "../account/worker-pilot";
import { RunStore } from "../state/run-recorder";
import { parseMarkdownTaskQuery } from "../trackers/markdown/markdown-task-tracker-client";
import { extractQueryLabels } from "../trackers/query-labels";
import { dashboardUrlFor } from "../worker/service-report";
import { loadWorkspaceConfig } from "../workspace/config";
import { workspaceConfigPath, workspaceDbPath } from "../workspace/paths";
import { errorMessage } from "./worker-init-fs";
import { askYesNo } from "./worker-init-policy";
import type { LogFn, PromptFn } from "./worker-init-policy";

/** Title of the sample task; says it is a DevIntern sample. */
export const SAMPLE_TASK_TITLE = "DevIntern sample task: add a short note to CONTRIBUTING.md";

/** Body of the sample task: one docs-only change that cannot break the repository. */
export const SAMPLE_TASK_BODY = [
  "This is a sample task created by `devintern worker init` so you can watch DevIntern's first run.",
  "",
  'Add a short "Working with DevIntern" section to `CONTRIBUTING.md` (create the file if it does not exist):',
  "two or three sentences saying that tickets matching the worker's query are picked up by DevIntern,",
  "which opens a pull request for review.",
  "",
  "Change only `CONTRIBUTING.md`. Do not touch code, tests, dependencies, or configuration.",
  "Close or delete this ticket if you do not want the change.",
].join("\n");

/** File name stem of the markdown sample task (its task key). */
export const SAMPLE_MARKDOWN_STEM = "devintern-sample-first-task";

/** Default bound on waiting for the worker to start the sample task. */
export const FIRST_RUN_WAIT_MS = 120_000;

const FIRST_RUN_POLL_MS = 3_000;

/** A created sample ticket (or task file, or ad-hoc task). */
export interface CreatedSampleTask {
  /** The worker's task key for it (`42`, a markdown stem, an ad-hoc key). */
  key: string;
  /** Where to open it, when the tracker has a page for it. */
  url?: string;
}

/** Creates a sample ticket in one tracker. */
export interface SampleTicketOps {
  /** Where the ticket goes, for messages: `owner/repo`, the GitLab project, a folder. */
  location: string;
  /** What gets created, for the question: "issue", "task file". */
  noun: string;
  /**
   * Create the sample. `match` comes from {@link sampleTaskMatch}: labels to
   * apply (issue trackers) or frontmatter fields to set (markdown).
   */
  create(match: SampleTaskMatch): Promise<CreatedSampleTask>;
}

/** Builds the sample ticket operations, or undefined when the tracker cannot create one. */
export type SampleTicketOpsFactory = (
  tracker: string,
  env: Record<string, string | undefined>,
) => SampleTicketOps | undefined;

/** How a sample ticket satisfies the saved query. */
export interface SampleTaskMatch {
  /** Labels to apply (GitHub, GitLab). */
  labels: string[];
  /** Frontmatter fields to set (markdown). */
  fields: Record<string, string>;
  /** Query terms the sample cannot satisfy automatically; the user has to. */
  unmatched: string[];
}

/** A run of the sample task, as far as the wizard needs it. */
export interface SampleRun {
  id: number;
  status: string;
}

/** Everything the first-task offer needs; injected by the CLI, absent in tests that skip it. */
export interface FirstTaskDeps {
  /** Sample ticket creation per tracker; undefined (or no ops) falls back to `worker add`. */
  sampleTicketOps?: SampleTicketOpsFactory;
  /** Queue the sample as an ad-hoc task (`devintern worker add`). */
  enqueueAdHoc?: (ctx: {
    workspaceDir: string;
    repo?: string;
  }) => Promise<CreatedSampleTask | { error: string }>;
  /** The newest run of `taskKey` started at or after `since` (ms), or null. */
  findRun?: (workspaceDir: string, taskKey: string, since: number) => SampleRun | null;
  /** Bound on waiting for the run to start (default {@link FIRST_RUN_WAIT_MS}). */
  waitMs?: number;
  /** How often the run list is read (default 3s). */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** What the offer needs from the wizard run. */
export interface FirstTaskContext {
  trackerType: string;
  trackerName: string;
  workspaceDir: string;
  repoName?: string;
  log: LogFn;
  prompt: PromptFn;
  /** Tracker credentials (the wizard keeps them in `process.env`). */
  env: Record<string, string | undefined>;
  deps: FirstTaskDeps;
}

/** Query terms that only say "open issues", which a new issue already is. */
const OPEN_TERMS = new Set(["is:open", "state:open", "state:opened", "is:issue", "type:issue"]);

/** GitLab label filters that are not label names. */
const GITLAB_LABEL_KEYWORDS = new Set(["none", "any"]);

/** A `label:`/`labels:` term, quoted or bare, possibly comma-separated and negated. */
const LABEL_TERM = /(^|\s)-?labels?:(?:"[^"]*"|'[^']*'|[^\s,]+)(?:,(?:"[^"]*"|'[^']*'|[^\s,]+))*/gi;

/**
 * How a sample ticket can match `query`: the labels (GitHub, GitLab) or
 * frontmatter fields (markdown) to set, and the terms it cannot satisfy.
 *
 * @param tracker - `TASK_TRACKER` value
 * @param query - The saved ready-tasks query
 */
export function sampleTaskMatch(tracker: string, query: string): SampleTaskMatch {
  if (tracker === "markdown") {
    const { filters, text } = parseMarkdownTaskQuery(query);
    return { labels: [], fields: filters, unmatched: text ? [text] : [] };
  }
  if (tracker === "github" || tracker === "gitlab") {
    const labels = extractQueryLabels(query).filter(
      (name) => !(tracker === "gitlab" && GITLAB_LABEL_KEYWORDS.has(name.toLowerCase())),
    );
    const unmatched = query
      .replace(LABEL_TERM, " ")
      .split(/\s+/)
      .filter((term) => term && !OPEN_TERMS.has(term.toLowerCase()));
    return { labels, fields: {}, unmatched };
  }
  return { labels: [], fields: {}, unmatched: [] };
}

/** Markdown sample file: frontmatter from the query's filters, then the task. */
export function renderSampleTaskFile(fields: Record<string, string>): string {
  const frontmatter = Object.entries({ ...fields, sample: "devintern" })
    .map(([key, value]) => `${key}: ${/^[\w.-]+$/.test(value) ? value : JSON.stringify(value)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n# ${SAMPLE_TASK_TITLE}\n\n${SAMPLE_TASK_BODY}\n`;
}

/** First free `devintern-sample-first-task[-N].md` in `dir`. */
function freeSamplePath(dir: string): { path: string; key: string } {
  for (let n = 1; ; n++) {
    const key = n === 1 ? SAMPLE_MARKDOWN_STEM : `${SAMPLE_MARKDOWN_STEM}-${n}`;
    const path = join(dir, `${key}.md`);
    if (!existsSync(path)) return { path, key };
  }
}

/**
 * Sample ticket creation against the tracker API (GitHub, GitLab) or the
 * tasks folder (markdown), built from the same credentials the worker uses.
 * Undefined for other trackers and for incomplete credentials.
 */
export const defaultSampleTicketOps: SampleTicketOpsFactory = (tracker, env) => {
  if (tracker === "github") {
    const [owner, repo] = (env.GITHUB_REPO ?? "").split("/");
    if (!env.GITHUB_TOKEN || !owner || !repo) return undefined;
    const client = new GitHubClient({ token: env.GITHUB_TOKEN, owner, repo });
    return {
      location: `${owner}/${repo}`,
      noun: "issue",
      create: async (match) => {
        const issue = await client.createIssue(SAMPLE_TASK_TITLE, SAMPLE_TASK_BODY, match.labels);
        return { key: String(issue.number), url: issue.html_url };
      },
    };
  }
  if (tracker === "gitlab") {
    if (!env.GITLAB_TOKEN || !env.GITLAB_PROJECT) return undefined;
    const client = new GitLabClient({
      token: env.GITLAB_TOKEN,
      projectPath: env.GITLAB_PROJECT,
      baseUrl: sanitizeGitlabBaseUrl(env.GITLAB_BASE_URL),
    });
    return {
      location: env.GITLAB_PROJECT,
      noun: "issue",
      create: async (match) => {
        const issue = await client.createIssue(SAMPLE_TASK_TITLE, SAMPLE_TASK_BODY, match.labels);
        return { key: String(issue.iid), ...(issue.web_url ? { url: issue.web_url } : {}) };
      },
    };
  }
  if (tracker === "markdown") {
    if (!env.MARKDOWN_TASKS_DIR) return undefined;
    const dir = resolve(env.MARKDOWN_TASKS_DIR);
    return {
      location: dir,
      noun: "task file",
      create: async (match) => {
        mkdirSync(dir, { recursive: true });
        const { path, key } = freeSamplePath(dir);
        writeFileSync(path, renderSampleTaskFile(match.fields), { flag: "wx" });
        return { key, url: path };
      },
    };
  }
  return undefined;
};

/**
 * `devintern worker add` with the sample task, for the `try-first-task` next
 * step and the wizard's fallback hint.
 *
 * @param workspaceDir - Workspace home (adds `DEVINTERN_WORKSPACE_DIR=` when not the default)
 * @param repo - `[[repos]]` name, when the workspace may have several
 * @param home - Home directory override (tests)
 */
export function sampleTaskAddCommand(workspaceDir: string, repo?: string, home?: string): string {
  return (
    `${workspaceEnvPrefixFor(workspaceDir, home)}devintern worker add` +
    (repo ? ` --repo ${shellQuote(repo)}` : "") +
    ` --title ${shellQuote(SAMPLE_TASK_TITLE)}` +
    // One line, so the printed command copies cleanly; Markdown reads it the same.
    ` --body ${shellQuote(SAMPLE_TASK_BODY.replace(/\n+/g, " "))}`
  );
}

/** Newest run of `taskKey` in the workspace queue DB started at or after `since`. */
export function defaultFindSampleRun(
  workspaceDir: string,
  taskKey: string,
  since: number,
): SampleRun | null {
  const dbPath = workspaceDbPath(workspaceDir);
  if (!existsSync(dbPath)) return null;
  let store: RunStore | undefined;
  try {
    store = new RunStore(dbPath, { readonly: true });
    const run = store.latestRunByTaskKey([taskKey]).get(taskKey);
    return run && run.startedAt >= since ? { id: run.id, status: run.status } : null;
  } catch {
    // The worker may be creating the tables; the next poll reads again.
    return null;
  } finally {
    store?.close();
  }
}

/**
 * Queue the sample through `devintern worker add --json` in-process and read
 * the task key from its JSON line.
 */
export async function defaultEnqueueSampleAdHoc(ctx: {
  workspaceDir: string;
  repo?: string;
}): Promise<CreatedSampleTask | { error: string }> {
  const { runWorkerAdd } = await import("../workspace/add-command");
  const out: string[] = [];
  const errors: string[] = [];
  const args = [
    "--workspace",
    workspaceConfigPath(ctx.workspaceDir),
    ...(ctx.repo ? ["--repo", ctx.repo] : []),
    "--title",
    SAMPLE_TASK_TITLE,
    "--body",
    SAMPLE_TASK_BODY,
    "--json",
  ];
  const code = await runWorkerAdd(args, {
    log: (message) => out.push(message),
    error: (message) => errors.push(message),
  });
  for (const line of out) {
    try {
      const parsed = JSON.parse(line) as { taskKey?: unknown };
      if (code === 0 && typeof parsed.taskKey === "string") return { key: parsed.taskKey };
    } catch {
      // Not the JSON line.
    }
  }
  return { error: errors.join(" ").trim() || `devintern worker add exited ${code}` };
}

/** `[defaults].poll_interval`, for the "not picked up yet" message. */
function pollIntervalSeconds(workspaceDir: string): number | undefined {
  try {
    return loadWorkspaceConfig(workspaceConfigPath(workspaceDir)).defaults.pollIntervalSeconds;
  } catch {
    return undefined;
  }
}

/** The saved ready-tasks query, or "" when the workspace cannot be read. */
function savedQuery(workspaceDir: string): string {
  try {
    return loadWorkspaceConfig(workspaceConfigPath(workspaceDir)).defaults.taskQuery ?? "";
  } catch {
    return "";
  }
}

/** Poll the run list until the sample's run starts or the bound passes. */
export async function waitForSampleRun(
  ctx: FirstTaskContext,
  task: CreatedSampleTask,
  since: number,
): Promise<SampleRun | null> {
  const { deps, workspaceDir, log } = ctx;
  const findRun = deps.findRun ?? defaultFindSampleRun;
  const waitMs = deps.waitMs ?? FIRST_RUN_WAIT_MS;
  const pollMs = deps.pollMs ?? FIRST_RUN_POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;
  const dashboard = dashboardUrlFor(workspaceDir);
  const minutes = Math.max(1, Math.round(waitMs / 60_000));
  log(
    `⏳ Waiting up to ${minutes} minute${minutes === 1 ? "" : "s"} for the worker to start ${task.key}…`,
  );
  const deadline = now() + waitMs;
  for (;;) {
    const run = findRun(workspaceDir, task.key, since);
    if (run) {
      log(`▶️  The worker started ${task.key} (run #${run.id}).`);
      log(
        dashboard
          ? `   Watch it: ${dashboard}/#/runs/${run.id}`
          : "   Follow it with `devintern worker status`.",
      );
      return run;
    }
    if (now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  const interval = pollIntervalSeconds(workspaceDir);
  log(
    `ℹ️  The worker has not started ${task.key} yet` +
      (interval ? ` (it checks for tasks every ${interval}s).` : "."),
  );
  log(
    dashboard
      ? `   It shows up in ${dashboard}/#/runs when it starts.`
      : "   Check on it with `devintern worker status`.",
  );
  return null;
}

/**
 * Offer the sample first task and, once created, show its run starting.
 * Call only when the worker is running and nothing blocks it.
 *
 * @returns The created task, or undefined when nothing was created
 */
export async function offerFirstTask(
  ctx: FirstTaskContext,
): Promise<CreatedSampleTask | undefined> {
  const { deps, log, trackerType, trackerName, workspaceDir } = ctx;
  const ops = deps.sampleTicketOps?.(trackerType, ctx.env);
  const since = (deps.now ?? Date.now)();
  if (!ops) return offerAdHoc(ctx, since);

  const query = savedQuery(workspaceDir);
  const match = sampleTaskMatch(trackerType, query);
  const question =
    ops.noun === "issue"
      ? `\nCreate a sample ticket in ${ops.location} so you can watch the first run? [Y/n]: `
      : `\nWrite a sample ${ops.noun} to ${ops.location} so you can watch the first run? [Y/n]: `;
  if (!(await askYesNo(ctx, question, true))) {
    log("   No sample created.");
    return undefined;
  }
  let task: CreatedSampleTask;
  try {
    task = await ops.create(match);
  } catch (error) {
    log(`⚠️  Could not create the sample ${ops.noun}: ${errorMessage(error)}`);
    log(
      `   Queue it without the tracker instead: ${sampleTaskAddCommand(workspaceDir, ctx.repoName)}`,
    );
    return undefined;
  }
  const labels = match.labels.length > 0 ? `, labeled ${match.labels.join(", ")}` : "";
  log(
    `🧪 Created the sample ${ops.noun} ${task.key} in ${trackerName}${labels}` +
      (task.url ? `: ${task.url}` : "."),
  );
  if (match.unmatched.length > 0) {
    log(
      `⚠️  Your query also selects on ${match.unmatched.join(" ")}, which setup cannot set. ` +
        `Make ${task.key} match it in ${trackerName} so the worker picks it up.`,
    );
    return task;
  }
  await waitForSampleRun(ctx, task, since);
  return task;
}

/** No ticket creation for this tracker: offer the same task through `worker add`. */
async function offerAdHoc(
  ctx: FirstTaskContext,
  since: number,
): Promise<CreatedSampleTask | undefined> {
  const { deps, log, workspaceDir } = ctx;
  if (
    !(await askYesNo(
      ctx,
      "\nQueue a sample task with `devintern worker add` so you can watch the first run? [Y/n]: ",
      true,
    ))
  ) {
    log("   No sample created.");
    return undefined;
  }
  const enqueue = deps.enqueueAdHoc ?? defaultEnqueueSampleAdHoc;
  let result: CreatedSampleTask | { error: string };
  try {
    result = await enqueue({ workspaceDir, ...(ctx.repoName ? { repo: ctx.repoName } : {}) });
  } catch (error) {
    result = { error: errorMessage(error) };
  }
  if ("error" in result) {
    log(`⚠️  Could not queue the sample task: ${result.error}`);
    log(`   Try it yourself: ${sampleTaskAddCommand(workspaceDir, ctx.repoName)}`);
    return undefined;
  }
  log(`🧪 Queued the sample task ${result.key}.`);
  await waitForSampleRun(ctx, result, since);
  return result;
}
