import { expect, test } from "bun:test";
import { detectTrackers, redactSecrets } from "../../helpers/tracker-smoke";
import {
  expandHomePath,
  mergeWorkspaceEnv,
  parseWorkspaceEnv,
  resolveWorkspaceEnvPath,
} from "../../helpers/workspace-env";

test("parses the worker env format without shell evaluation", () => {
  expect(
    parseWorkspaceEnv(
      [
        "# comment",
        "TRELLO_DEFAULT_LIST_NAME=To Do",
        'QUOTED="value with spaces"',
        "SINGLE='single quoted'",
        "EMPTY=",
        "EQUALS=a=b=c",
        "export EXPORTED=yes",
        "not a valid line",
      ].join("\n"),
    ),
  ).toEqual({
    TRELLO_DEFAULT_LIST_NAME: "To Do",
    QUOTED: "value with spaces",
    SINGLE: "single quoted",
    EMPTY: "",
    EQUALS: "a=b=c",
    EXPORTED: "yes",
  });
});

test("resolves the workspace env path with explicit paths taking precedence", () => {
  expect(resolveWorkspaceEnvPath({ DEVINTERN_ENV_FILE: "~/custom.env" }, "/home/test")).toBe(
    "/home/test/custom.env",
  );
  expect(resolveWorkspaceEnvPath({ DEVINTERN_WORKSPACE_DIR: "/tmp/workspace" }, "/home/test")).toBe(
    "/tmp/workspace/.env",
  );
  expect(resolveWorkspaceEnvPath({}, "/home/test")).toBe("/home/test/.devintern/.env");
  expect(expandHomePath("~/tasks", "/home/test")).toBe("/home/test/tasks");
});

test("process environment overrides non-empty file values", () => {
  expect(
    mergeWorkspaceEnv(
      { TASK_TRACKER: "jira", JIRA_BASE_URL: "https://file.example", EMPTY_OVERRIDE: "file" },
      { TASK_TRACKER: "trello", JIRA_BASE_URL: " ", EMPTY_OVERRIDE: "process" },
    ),
  ).toEqual({
    TASK_TRACKER: "trello",
    JIRA_BASE_URL: "https://file.example",
    EMPTY_OVERRIDE: "process",
  });
});

test("detects trackers from their required variables", () => {
  const candidates = detectTrackers({
    JIRA_BASE_URL: "https://example.atlassian.net",
    JIRA_EMAIL: "user@example.com",
    JIRA_API_TOKEN: "token",
    TRELLO_API_TOKEN: "token",
  });
  expect(candidates.find((candidate) => candidate.check.id === "jira")?.configured).toBe(true);
  expect(candidates.find((candidate) => candidate.check.id === "trello")?.configured).toBe(false);
  expect(candidates.find((candidate) => candidate.check.id === "linear")?.configured).toBe(false);
});

test("redacts secrets and their URL-encoded forms", () => {
  const env = {
    TRELLO_API_KEY: "key-1234",
    TRELLO_API_TOKEN: "token/with+symbols",
  };
  const redacted = redactSecrets(
    `https://api.example/search?key=${env.TRELLO_API_KEY}&token=${encodeURIComponent(env.TRELLO_API_TOKEN)} ` +
      `and raw ${env.TRELLO_API_TOKEN}`,
    env,
  );
  expect(redacted).not.toContain(env.TRELLO_API_KEY);
  expect(redacted).not.toContain(env.TRELLO_API_TOKEN);
  expect(redacted).toContain("[redacted]");
});
