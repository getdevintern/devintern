import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_TRELLO_API_KEY,
  loadEnvFromConfigDir,
  loadTrackerConfig,
  parseGitHubRepo,
  parseTrackerConfigFromEnv,
  sanitizeDomain,
} from "./src/config/load-tracker-config.ts";

const TRACKER_ENV_KEYS = [
  "TASK_TRACKER",
  "MARKDOWN_TASKS_DIR",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_DEFAULT_PROJECT_KEY",
  "LINEAR_API_KEY",
  "LINEAR_DEFAULT_TEAM_KEY",
  "TRELLO_API_KEY",
  "TRELLO_API_TOKEN",
  "TRELLO_DEFAULT_BOARD_ID",
  "TRELLO_DEFAULT_LIST_NAME",
  "AZURE_DEVOPS_ORG",
  "AZURE_DEVOPS_PAT",
  "AZURE_DEVOPS_PROJECT",
  "ASANA_API_TOKEN",
  "ASANA_DEFAULT_PROJECT_GID",
  "GITHUB_TOKEN",
  "GITHUB_REPO",
  "GITHUB_OWNER",
  "DEVINTERN_VERBOSE",
] as const;

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  const saved: EnvSnapshot = {};
  for (const key of TRACKER_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: EnvSnapshot): void {
  for (const key of TRACKER_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("sanitizeDomain", () => {
  test("strips protocol and trailing slashes", () => {
    expect(sanitizeDomain("https://acme.atlassian.net/")).toBe("acme.atlassian.net");
    expect(sanitizeDomain("http://acme.atlassian.net")).toBe("acme.atlassian.net");
    expect(sanitizeDomain("acme.atlassian.net")).toBe("acme.atlassian.net");
  });
});

describe("parseGitHubRepo", () => {
  test("parses owner/repo format", () => {
    expect(parseGitHubRepo("acme/my-app")).toEqual({
      owner: "acme",
      repo: "my-app",
      repository: "acme/my-app",
    });
  });

  test("supports legacy GITHUB_OWNER fallback", () => {
    expect(parseGitHubRepo("my-app", "acme")).toEqual({
      owner: "acme",
      repo: "my-app",
      repository: "acme/my-app",
    });
  });

  test("throws on invalid repo value", () => {
    expect(() => parseGitHubRepo("not-a-valid-repo")).toThrow(/Invalid GITHUB_REPO/);
    expect(() => parseGitHubRepo("/missing-owner")).toThrow(/Invalid GITHUB_REPO/);
  });
});

describe("parseTrackerConfigFromEnv", () => {
  let savedEnv: EnvSnapshot;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    for (const key of TRACKER_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  test("defaults to jira backend", () => {
    setEnv({
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "user@example.com",
      JIRA_API_TOKEN: "token",
      JIRA_DEFAULT_PROJECT_KEY: "ACME",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.backend.type).toBe("jira");
    expect(config.jira).toEqual({
      domain: "acme.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
      defaultProjectKey: "ACME",
      verbose: false,
    });
  });

  test("throws when jira env is incomplete", () => {
    setEnv({
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "user@example.com",
    });

    expect(() => parseTrackerConfigFromEnv()).toThrow(/Missing required environment variables/);
  });

  test("parses linear config", () => {
    setEnv({
      TASK_TRACKER: "linear",
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_DEFAULT_TEAM_KEY: "ENG",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.backend.type).toBe("linear");
    expect(config.linear).toEqual({
      apiKey: "lin_api_test",
      defaultTeamKey: "ENG",
    });
  });

  test("parses trello config with bundled api key fallback", () => {
    setEnv({
      TASK_TRACKER: "trello",
      TRELLO_API_TOKEN: "trello-token",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.backend.type).toBe("trello");
    expect(config.trello?.apiKey).toBe(BUNDLED_TRELLO_API_KEY);
    expect(config.trello?.apiToken).toBe("trello-token");
  });

  test("throws when trello token is missing", () => {
    setEnv({ TASK_TRACKER: "trello" });
    expect(() => parseTrackerConfigFromEnv()).toThrow(/Trello backend requires TRELLO_API_TOKEN/);
  });

  test("parses azure devops config", () => {
    setEnv({
      TASK_TRACKER: "azure-devops",
      AZURE_DEVOPS_ORG: "my-org",
      AZURE_DEVOPS_PAT: "pat-token",
      AZURE_DEVOPS_PROJECT: "MyProject",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.backend.type).toBe("azure-devops");
    expect(config.azureDevOps).toEqual({
      organization: "my-org",
      pat: "pat-token",
      defaultProject: "MyProject",
    });
  });

  test("parses asana config", () => {
    setEnv({
      TASK_TRACKER: "asana",
      ASANA_API_TOKEN: "asana-pat",
      ASANA_DEFAULT_PROJECT_GID: "12345",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.backend.type).toBe("asana");
    expect(config.asana).toEqual({
      apiToken: "asana-pat",
      defaultProjectGid: "12345",
    });
  });

  test("parses github config", () => {
    setEnv({
      TASK_TRACKER: "github",
      GITHUB_TOKEN: "ghp_test",
      GITHUB_REPO: "acme/my-app",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.backend.type).toBe("github");
    expect(config.github).toEqual({
      token: "ghp_test",
      owner: "acme",
      repo: "my-app",
      repository: "acme/my-app",
    });
  });

  test("parses markdown config", () => {
    setEnv({
      TASK_TRACKER: "markdown",
      MARKDOWN_TASKS_DIR: ".tasks",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.backend.type).toBe("markdown");
    expect(config.backend.directory).toBe(".tasks");
  });

  test("reads DEVINTERN_VERBOSE env var", () => {
    setEnv({
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "user@example.com",
      JIRA_API_TOKEN: "token",
      JIRA_DEFAULT_PROJECT_KEY: "ACME",
      DEVINTERN_VERBOSE: "1",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.verbose).toBe(true);
    expect(config.jira?.verbose).toBe(true);
  });

  test("defaults verbose to false when DEVINTERN_VERBOSE is unset", () => {
    setEnv({
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "user@example.com",
      JIRA_API_TOKEN: "token",
      JIRA_DEFAULT_PROJECT_KEY: "ACME",
    });

    const config = parseTrackerConfigFromEnv();
    expect(config.verbose).toBe(false);
    expect(config.jira?.verbose).toBe(false);
  });
});

describe("loadEnvFromConfigDir", () => {
  let savedEnv: EnvSnapshot;
  let originalCwd: string;
  let tempRoot: string;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "task-trackers-env-"));
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restoreEnv(savedEnv);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("loads values from config dir .env and strips quotes", async () => {
    const configDir = ".devintern-test";
    mkdirSync(join(tempRoot, configDir), { recursive: true });
    writeFileSync(
      join(tempRoot, configDir, ".env"),
      [
        "# comment line",
        'JIRA_EMAIL="quoted@example.com"',
        "JIRA_API_TOKEN=plain-token",
        "EMPTY=",
      ].join("\n"),
    );

    await loadEnvFromConfigDir(configDir);

    expect(process.env.JIRA_EMAIL).toBe("quoted@example.com");
    expect(process.env.JIRA_API_TOKEN).toBe("plain-token");
  });

  test("is a no-op when .env file is missing", async () => {
    delete process.env.JIRA_EMAIL;
    await loadEnvFromConfigDir(".missing-config-dir");
    expect(process.env.JIRA_EMAIL).toBeUndefined();
  });

  test("finds .env in parent directory", async () => {
    const configDir = ".devintern-test";
    const childDir = join(tempRoot, "src", "components");
    mkdirSync(childDir, { recursive: true });
    mkdirSync(join(tempRoot, configDir), { recursive: true });
    writeFileSync(join(tempRoot, configDir, ".env"), "JIRA_EMAIL=parent@example.com\n");

    const previousCwd = process.cwd();
    process.chdir(childDir);
    try {
      delete process.env.JIRA_EMAIL;
      await loadEnvFromConfigDir(configDir);

      expect(process.env.JIRA_EMAIL).toBe("parent@example.com");
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("prefers nearest .env over parent .env", async () => {
    const configDir = ".devintern-test";
    const childDir = join(tempRoot, "src");
    mkdirSync(childDir, { recursive: true });
    mkdirSync(join(tempRoot, configDir), { recursive: true });
    mkdirSync(join(childDir, configDir), { recursive: true });
    writeFileSync(join(tempRoot, configDir, ".env"), "JIRA_EMAIL=parent@example.com\n");
    writeFileSync(join(childDir, configDir, ".env"), "JIRA_EMAIL=child@example.com\n");

    const previousCwd = process.cwd();
    process.chdir(childDir);
    try {
      delete process.env.JIRA_EMAIL;
      await loadEnvFromConfigDir(configDir);

      expect(process.env.JIRA_EMAIL).toBe("child@example.com");
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("finds plain .env when config dir .env is missing", async () => {
    const childDir = join(tempRoot, "src");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(tempRoot, ".env"), "JIRA_EMAIL=plain@example.com\n");

    const previousCwd = process.cwd();
    process.chdir(childDir);
    try {
      delete process.env.JIRA_EMAIL;
      await loadEnvFromConfigDir(".missing-config-dir");

      expect(process.env.JIRA_EMAIL).toBe("plain@example.com");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe("loadTrackerConfig", () => {
  let savedEnv: EnvSnapshot;
  let originalCwd: string;
  let tempRoot: string;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "task-trackers-load-"));
    process.chdir(tempRoot);

    for (const key of TRACKER_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restoreEnv(savedEnv);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("loads env file then parses tracker config", async () => {
    const configDir = ".devintern-pm";
    mkdirSync(join(tempRoot, configDir), { recursive: true });
    writeFileSync(
      join(tempRoot, configDir, ".env"),
      [
        "TASK_TRACKER=linear",
        "LINEAR_API_KEY=lin_api_from_file",
        "LINEAR_DEFAULT_TEAM_KEY=PLAT",
      ].join("\n"),
    );

    const config = await loadTrackerConfig(configDir);
    expect(config.backend.type).toBe("linear");
    expect(config.linear?.apiKey).toBe("lin_api_from_file");
    expect(config.linear?.defaultTeamKey).toBe("PLAT");
  });
});
