import { readdirSync, statSync } from "node:fs";
import { expandHomePath } from "./workspace-env";

/** Tracker ids mirrored from `TRACKER_CAPABILITIES` in `@getdevintern/code`. */
export type TrackerSmokeId =
  | "jira"
  | "trello"
  | "markdown"
  | "linear"
  | "asana"
  | "azure-devops"
  | "github"
  | "gitlab";

export interface TrackerSmokeResult {
  /** One-line pass summary safe to print (never contains credentials). */
  summary: string;
  /** Extra non-secret details, one line each. */
  details: string[];
}

export interface TrackerSmokeCheck {
  id: TrackerSmokeId;
  displayName: string;
  /** Env vars that must be non-empty for this smoke to run. */
  requiredEnv: readonly string[];
  /**
   * Read-only check. Undefined when the tracker is detected but has no
   * read-only check yet (see `docs/tracker-e2e-plan.md`).
   */
  run?: (env: Record<string, string>) => Promise<TrackerSmokeResult>;
}

export interface TrackerCandidate {
  check: TrackerSmokeCheck;
  configured: boolean;
  missing: string[];
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Read-only checks for the trackers a worker workspace can have configured.
 *
 * The worker env file is the source, but the checks never fall back from
 * tracker-specific configuration to anything else and never write to a
 * tracker. Jira's project key is optional here: when absent, the first
 * accessible project is inspected (read-only) instead of failing.
 */
export const TRACKER_SMOKE_CHECKS: readonly TrackerSmokeCheck[] = [
  {
    id: "jira",
    displayName: "Jira",
    // JIRA_DEFAULT_PROJECT_KEY is optional for the smoke: it is required by
    // `@devintern/pm`, but `@getdevintern/code` can work from issue keys and
    // team queries without it.
    requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    run: runJiraSmoke,
  },
  {
    id: "trello",
    displayName: "Trello",
    // The product falls back to a bundled API key; the smoke requires the
    // explicit key so it never depends on a value compiled into the product.
    requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"],
    run: runTrelloSmoke,
  },
  {
    id: "markdown",
    displayName: "Markdown files",
    requiredEnv: ["MARKDOWN_TASKS_DIR"],
    run: runMarkdownSmoke,
  },
  {
    id: "linear",
    displayName: "Linear",
    requiredEnv: ["LINEAR_API_KEY"],
  },
  {
    id: "asana",
    displayName: "Asana",
    requiredEnv: ["ASANA_API_TOKEN"],
  },
  {
    id: "azure-devops",
    displayName: "Azure DevOps",
    requiredEnv: ["AZURE_DEVOPS_ORG", "AZURE_DEVOPS_PAT", "AZURE_DEVOPS_PROJECT"],
  },
  {
    id: "github",
    displayName: "GitHub Issues",
    requiredEnv: ["GITHUB_TOKEN", "GITHUB_REPO"],
  },
  {
    id: "gitlab",
    displayName: "GitLab Issues",
    requiredEnv: ["GITLAB_TOKEN", "GITLAB_PROJECT"],
  },
];

/** Active tracker from `TASK_TRACKER` (the product default is Jira). */
export function getActiveTrackerId(env: Record<string, string>): string {
  return (env.TASK_TRACKER?.trim() || "jira").toLowerCase();
}

/** Detect every tracker whose required env is present. */
export function detectTrackers(env: Record<string, string>): TrackerCandidate[] {
  return TRACKER_SMOKE_CHECKS.map((check) => {
    const missing = check.requiredEnv.filter((key) => !env[key]?.trim());
    return { check, configured: missing.length === 0, missing };
  });
}

/**
 * Redact credential values (and their URL-encoded forms) from error text.
 *
 * Trello authenticates through query parameters, so a raw fetch error can
 * include the token in a URL. Nothing printed by this module may contain it.
 */
export function redactSecrets(text: string, env: Record<string, string>): string {
  const secretKeys = [
    "JIRA_API_TOKEN",
    "TRELLO_API_KEY",
    "TRELLO_API_TOKEN",
    "LINEAR_API_KEY",
    "ASANA_API_TOKEN",
    "AZURE_DEVOPS_PAT",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
  ];
  let redacted = text;
  for (const key of secretKeys) {
    const value = env[key]?.trim();
    if (!value || value.length < 4) continue;
    for (const candidate of new Set([value, encodeURIComponent(value)])) {
      redacted = redacted.split(candidate).join("[redacted]");
    }
  }
  return redacted;
}

async function runJiraSmoke(env: Record<string, string>): Promise<TrackerSmokeResult> {
  const baseUrl = normalizeBaseUrl(required(env, "JIRA_BASE_URL"));
  const email = required(env, "JIRA_EMAIL");
  const token = required(env, "JIRA_API_TOKEN");
  const authorization = `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;

  const jiraJson = async (
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<unknown> => {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authorization,
    };
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetchJson(`Jira ${method} ${path.split("?")[0]}`, `${baseUrl}${path}`, env, init);
  };

  const me = asRecord(await jiraJson("/rest/api/3/myself"), "Jira GET /myself");
  const user =
    readString(me, "displayName") || readString(me, "emailAddress") || "authenticated user";

  let projectKey = env.JIRA_DEFAULT_PROJECT_KEY?.trim() ?? "";
  let projectSource = "JIRA_DEFAULT_PROJECT_KEY";
  if (!projectKey) {
    const projects = asArray(
      await jiraJson("/rest/api/3/project?maxResults=50"),
      "Jira GET /project",
    );
    const first = projects[0];
    if (first === undefined) throw new Error("Jira account can read no projects");
    const project = asRecord(first, "Jira project");
    projectKey = readString(project, "key");
    if (!projectKey) throw new Error("Jira project response has no key");
    projectSource = "first accessible project";
  }

  const encodedProject = encodeURIComponent(projectKey);
  const project = asRecord(
    await jiraJson(`/rest/api/3/project/${encodedProject}`),
    "Jira GET /project/{key}",
  );
  const projectName = readString(project, "name");

  const statusEntries = asArray(
    await jiraJson(`/rest/api/3/project/${encodedProject}/statuses`),
    "Jira GET /project/{key}/statuses",
  );
  const statusNames = uniqueStrings(
    statusEntries.flatMap((entry) => {
      const issueType = asRecord(entry, "Jira issue type statuses");
      return asArray(issueType.statuses ?? [], "Jira statuses").map((status) =>
        readString(asRecord(status, "Jira status"), "name"),
      );
    }),
  );
  if (statusNames.length === 0) {
    throw new Error(`Jira project ${projectKey} exposes no workflow statuses`);
  }

  const createMeta = asRecord(
    await jiraJson(`/rest/api/3/issue/createmeta/${encodedProject}/issuetypes?maxResults=50`),
    "Jira GET /issue/createmeta/{key}/issuetypes",
  );
  const issueTypes = asArray(createMeta.issueTypes, "Jira create metadata issue types");
  if (issueTypes.length === 0) {
    throw new Error(`Jira project ${projectKey} exposes no creatable issue types`);
  }
  const issueTypeNames = uniqueStrings(
    issueTypes.map((issueType) => readString(asRecord(issueType, "Jira issue type"), "name")),
  );

  const permissionResponse = asRecord(
    await jiraJson(
      `/rest/api/3/mypermissions?projectKey=${encodedProject}&permissions=BROWSE_PROJECTS,CREATE_ISSUES`,
    ),
    "Jira GET /mypermissions",
  );
  const permissions = asRecord(permissionResponse.permissions, "Jira permissions");
  for (const permission of ["BROWSE_PROJECTS", "CREATE_ISSUES"] as const) {
    const entry = asRecord(permissions[permission], `Jira permission ${permission}`);
    if (entry.havePermission !== true) {
      throw new Error(`Jira user lacks ${permission} on project ${projectKey}`);
    }
  }

  const search = asRecord(
    await jiraJson("/rest/api/3/search/jql", {
      method: "POST",
      body: {
        jql: `project = "${projectKey}" ORDER BY created DESC`,
        maxResults: 1,
        fields: ["summary"],
      },
    }),
    "Jira POST /search/jql",
  );
  asArray(search.issues, "Jira search issues");

  return {
    summary: `Jira: ${user} · project ${projectKey} · ${statusNames.length} statuses · ${issueTypeNames.length} issue types · search ok`,
    details: [
      `Project: ${projectKey}${projectName ? ` (${projectName})` : ""} [${projectSource}]`,
      `Statuses: ${statusNames.join(", ")}`,
      `Issue types: ${issueTypeNames.join(", ")}`,
    ],
  };
}

async function runTrelloSmoke(env: Record<string, string>): Promise<TrackerSmokeResult> {
  const baseUrl = normalizeBaseUrl(env.TRELLO_API_BASE_URL?.trim() || "https://api.trello.com/1");
  const key = required(env, "TRELLO_API_KEY");
  const token = required(env, "TRELLO_API_TOKEN");

  const trelloJson = async (
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown> => {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("key", key);
    url.searchParams.set("token", token);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return fetchJson(`Trello GET ${path}`, url.toString(), env, { method: "GET" });
  };

  const me = asRecord(
    await trelloJson("/members/me", { fields: "id,username,fullName" }),
    "Trello GET /members/me",
  );
  const user = readString(me, "username") || readString(me, "fullName") || "authenticated member";

  let boardReference = env.TRELLO_DEFAULT_BOARD_ID?.trim() ?? "";
  let boardSource = "TRELLO_DEFAULT_BOARD_ID";
  if (!boardReference) {
    const boards = asArray(
      await trelloJson("/members/me/boards", {
        filter: "open",
        fields: "id,name,closed,shortLink",
      }),
      "Trello GET /members/me/boards",
    );
    const first = boards[0];
    if (first === undefined) throw new Error("Trello member has no open boards");
    const board = asRecord(first, "Trello board");
    boardReference = readString(board, "id");
    if (!boardReference) throw new Error("Trello board response has no id");
    boardSource = "first open board";
  }

  // The board endpoint accepts a short link or a 24-character id.
  const board = asRecord(
    await trelloJson(`/boards/${encodeURIComponent(boardReference)}`, {
      fields: "id,name,closed,shortLink",
    }),
    "Trello GET /boards/{id}",
  );
  if (board.closed === true) {
    throw new Error(`Trello board ${boardReference} is closed`);
  }
  const boardId = readString(board, "id");
  if (!boardId) throw new Error("Trello board response has no id");
  const boardName = readString(board, "name") || boardReference;

  const lists = asArray(
    await trelloJson(`/boards/${encodeURIComponent(boardId)}/lists`, { fields: "id,name" }),
    "Trello GET /boards/{id}/lists",
  );
  const listNames = uniqueStrings(
    lists.map((list) => readString(asRecord(list, "Trello list"), "name")),
  );
  if (listNames.length === 0) {
    throw new Error(`Trello board ${boardName} exposes no lists`);
  }

  const defaultList = env.TRELLO_DEFAULT_LIST_NAME?.trim();
  if (defaultList && !listNames.some((name) => name.toLowerCase() === defaultList.toLowerCase())) {
    throw new Error(
      `Trello list "${defaultList}" not found on board "${boardName}". Available: ${listNames.join(", ")}`,
    );
  }

  // Trello search requires a 24-character board id, not the short link.
  const search = asRecord(
    await trelloJson("/search", {
      query: "is:open",
      idBoards: boardId,
      cards_limit: "1",
      card_fields: "id,name",
    }),
    "Trello GET /search",
  );
  asArray(search.cards, "Trello search cards");

  return {
    summary: `Trello: ${user} · board ${boardName} · ${listNames.length} lists · search ok`,
    details: [`Lists: ${listNames.join(", ")}`, `Board source: ${boardSource}`],
  };
}

async function runMarkdownSmoke(env: Record<string, string>): Promise<TrackerSmokeResult> {
  const directory = expandHomePath(required(env, "MARKDOWN_TASKS_DIR"));
  const stats = statSync(directory);
  if (!stats.isDirectory()) {
    throw new Error(`MARKDOWN_TASKS_DIR is not a directory: ${directory}`);
  }
  const taskCount = readdirSync(directory).filter((name) => name.endsWith(".md")).length;
  return {
    summary: `Markdown: ${directory} · ${taskCount} task file(s)`,
    details: [],
  };
}

async function fetchJson(
  label: string,
  url: string,
  env: Record<string, string>,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(`${label} failed: ${message}`, env));
  }

  try {
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim().slice(0, 300);
      throw new Error(
        `${label} returned HTTP ${response.status}${detail ? `: ${redactSecrets(detail, env)}` : ""}`,
      );
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${label} returned non-JSON content`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function required(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an unexpected response`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} returned an unexpected response`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
