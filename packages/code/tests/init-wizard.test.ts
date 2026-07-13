import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BUNDLED_TRELLO_API_KEY } from "@devintern/task-trackers";
import {
  TRACKER_SETUP,
  buildEnvExample,
  renderEnvFile,
  scaffoldProject,
} from "../src/lib/init-scaffold";
import { isInteractive, runInitWizard } from "../src/lib/init-wizard";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "init-wizard-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Prompt stub that answers from a queue and records questions. */
function promptQueue(answers: string[]) {
  const asked: string[] = [];
  const remaining = [...answers];
  const prompt = (question: string): Promise<string> => {
    asked.push(question);
    if (remaining.length === 0) {
      throw new Error(`Prompt queue exhausted at question: ${question}`);
    }
    return Promise.resolve(remaining.shift()!);
  };
  return { prompt, asked, remaining };
}

const silentLog = () => {};

describe("isInteractive", () => {
  test("true only for a TTY without escape flags", () => {
    expect(isInteractive(["bun", "cli", "init"], { isTTY: true })).toBe(true);
    expect(isInteractive(["bun", "cli", "init"], { isTTY: undefined })).toBe(false);
    expect(isInteractive(["bun", "cli", "init"], { isTTY: false })).toBe(false);
    expect(isInteractive(["bun", "cli", "init", "--yes"], { isTTY: true })).toBe(false);
    expect(isInteractive(["bun", "cli", "init", "--no-interactive"], { isTTY: true })).toBe(false);
  });
});

describe("buildEnvExample", () => {
  test("documents all trackers with links, commented values, and TASK_TRACKER example", () => {
    const template = buildEnvExample();
    expect(template).toContain("TASK_TRACKER=jira");
    for (const trackerId of Object.keys(TRACKER_SETUP)) {
      expect(template).toContain(`TASK_TRACKER=${trackerId})`);
    }
    expect(template).toContain("# JIRA_API_TOKEN=");
    expect(template).toContain("https://id.atlassian.com/manage-profile/security/api-tokens");
    expect(template).toContain("https://linear.app/settings/account/security");
    expect(template).toContain("https://app.asana.com/0/my-apps");
    expect(template).toContain("# MARKDOWN_TASKS_DIR=");
    // Agent + PR integration tail is preserved
    expect(template).toContain("AGENT_HARNESS=claude-code");
    expect(template).toContain("BITBUCKET_TOKEN");
  });
});

describe("renderEnvFile", () => {
  test("writes TASK_TRACKER, provided values, and comments out skipped optionals", () => {
    const env = renderEnvFile("jira", {
      JIRA_BASE_URL: "https://acme.atlassian.net",
      JIRA_EMAIL: "dev@acme.com",
      JIRA_API_TOKEN: "secret-token",
    });
    expect(env).toContain("TASK_TRACKER=jira");
    expect(env).toContain("JIRA_BASE_URL=https://acme.atlassian.net");
    expect(env).toContain("JIRA_API_TOKEN=secret-token");
    expect(env).toContain("# JIRA_DEFAULT_PROJECT_KEY=");
    expect(env).toContain("AGENT_HARNESS=claude-code");
  });

  test("writes extra values (PR token) under a dedicated section", () => {
    const env = renderEnvFile("linear", {
      LINEAR_API_KEY: "lin_api_123",
      GITHUB_TOKEN: "ghp_abc",
    });
    expect(env).toContain("TASK_TRACKER=linear");
    expect(env).toContain("LINEAR_API_KEY=lin_api_123");
    expect(env).toContain("# Pull Request integration\nGITHUB_TOKEN=ghp_abc");
  });
});

describe("scaffoldProject", () => {
  test("writes env files, settings.json, and .gitignore entries", () => {
    expect(scaffoldProject({ cwd: tempDir })).toBe(true);
    const configDir = join(tempDir, ".devintern-code");
    expect(readFileSync(join(configDir, ".env"), "utf8")).toBe(
      readFileSync(join(configDir, ".env.example"), "utf8"),
    );
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    expect(Object.keys(settings)).toContain("azure-devops");
    expect(readFileSync(join(tempDir, ".gitignore"), "utf8")).toContain(".devintern-code/.env");
  });

  test("refuses to touch an existing config dir", () => {
    expect(scaffoldProject({ cwd: tempDir })).toBe(true);
    expect(scaffoldProject({ cwd: tempDir, envContent: "OVERWRITTEN" })).toBe(false);
    expect(readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8")).not.toContain(
      "OVERWRITTEN",
    );
  });
});

describe("runInitWizard", () => {
  test("jira happy path: prompts, validates, writes real .env", async () => {
    const probeCalls: Array<{ trackerId: string; env: Record<string, string> }> = [];
    const { prompt } = promptQueue([
      "1", // jira
      "https://acme.atlassian.net",
      "dev@acme.com",
      "secret-token",
      "PROJ", // default project key
      "", // skip GITHUB_TOKEN PR step
    ]);

    await runInitWizard({
      prompt,
      probe: (trackerId, env) => {
        probeCalls.push({ trackerId, env });
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0].trackerId).toBe("jira");
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("TASK_TRACKER=jira");
    expect(env).toContain("JIRA_API_TOKEN=secret-token");
    expect(env).toContain("JIRA_DEFAULT_PROJECT_KEY=PROJ");
    expect(env).toContain("# GITHUB_TOKEN=");
    // .env.example keeps the full template
    const example = readFileSync(join(tempDir, ".devintern-code", ".env.example"), "utf8");
    expect(example).toContain("MARKDOWN_TASKS_DIR");
  });

  test("accepts tracker id input and re-prompts on invalid menu choice", async () => {
    const { prompt } = promptQueue([
      "99", // invalid number
      "not-a-tracker", // invalid id
      "linear",
      "lin_api_123",
      "", // skip team key
      "", // skip PR token
    ]);

    await runInitWizard({ prompt, probe: () => Promise.resolve(), cwd: tempDir, log: silentLog });

    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("TASK_TRACKER=linear");
    expect(env).toContain("LINEAR_API_KEY=lin_api_123");
  });

  test("failed probe: retry then success", async () => {
    let attempts = 0;
    const { prompt } = promptQueue([
      "linear",
      "lin_bad_then_good",
      "", // skip team key
      "r", // retry after failure
      "", // skip PR token
    ]);

    await runInitWizard({
      prompt,
      probe: () => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error("401")) : Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(attempts).toBe(2);
    expect(existsSync(join(tempDir, ".devintern-code", ".env"))).toBe(true);
  });

  test("failed probe: edit values then success", async () => {
    const seenKeys: string[] = [];
    const { prompt } = promptQueue([
      "linear",
      "lin_wrong",
      "", // skip team key
      "e", // edit values
      "lin_right",
      "", // skip team key again
      "", // skip PR token
    ]);

    await runInitWizard({
      prompt,
      probe: (_, env) => {
        seenKeys.push(env.LINEAR_API_KEY);
        return env.LINEAR_API_KEY === "lin_right"
          ? Promise.resolve()
          : Promise.reject(new Error("401"));
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(seenKeys).toEqual(["lin_wrong", "lin_right"]);
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("LINEAR_API_KEY=lin_right");
  });

  test("failed probe: skip validation still writes values with warning", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "asana",
      "asana-token",
      "", // skip project gid
      "s", // skip validation
      "", // skip PR token
    ]);

    await runInitWizard({
      prompt,
      probe: () => Promise.reject(new Error("network unreachable")),
      cwd: tempDir,
      log: (m) => logs.push(m),
    });

    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("ASANA_API_TOKEN=asana-token");
    const output = logs.join("\n");
    expect(output).toContain("Skipping validation");
    // Setup guides on devintern.com: printed after tracker selection and for
    // the optional PR-token step, and written into the generated .env.
    expect(output).toContain("https://devintern.com/docs/code/asana-integration");
    expect(output).toContain("https://devintern.com/docs/code/github-integration");
    expect(env).toContain("# Setup guide: https://devintern.com/docs/code/asana-integration");
  });

  test("fast track: reuses .devintern-pm credentials without re-prompting", async () => {
    mkdirSync(join(tempDir, ".devintern-pm"), { recursive: true });
    writeFileSync(
      join(tempDir, ".devintern-pm", ".env"),
      "TASK_TRACKER=linear\nLINEAR_API_KEY=lin_api_shared\nLINEAR_DEFAULT_TEAM_KEY=ENG\n",
      "utf8",
    );

    const probeEnvs: Array<Record<string, string>> = [];
    const { prompt, asked } = promptQueue([
      "y", // accept reuse
      "", // skip PR token
    ]);
    await runInitWizard({
      prompt,
      probe: (_, env) => {
        probeEnvs.push({ ...env });
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(asked.some((q) => q.includes("Enter a number"))).toBe(false);
    expect(probeEnvs[0].LINEAR_API_KEY).toBe("lin_api_shared");
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("TASK_TRACKER=linear");
    expect(env).toContain("LINEAR_API_KEY=lin_api_shared");
    expect(env).toContain("LINEAR_DEFAULT_TEAM_KEY=ENG");
  });

  test("fast track: declining reuse falls back to the tracker menu", async () => {
    mkdirSync(join(tempDir, ".devintern-pm"), { recursive: true });
    writeFileSync(
      join(tempDir, ".devintern-pm", ".env"),
      "TASK_TRACKER=linear\nLINEAR_API_KEY=lin_api_shared\n",
      "utf8",
    );

    const { prompt, asked } = promptQueue([
      "n", // decline reuse
      "markdown",
      "", // accept default tasks dir
      "", // skip PR token
    ]);
    await runInitWizard({ prompt, probe: () => Promise.resolve(), cwd: tempDir, log: silentLog });

    expect(asked.some((q) => q.includes("Enter a number"))).toBe(true);
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("TASK_TRACKER=markdown");
    expect(env).not.toContain("lin_api_shared");
  });

  test("trello bundled key default is omitted from .env so fallback applies", async () => {
    const probeEnvs: Array<Record<string, string>> = [];
    const { prompt } = promptQueue([
      "trello",
      "", // accept bundled API key default
      "trello-token",
      "", // skip board id
      "", // skip PR token
    ]);

    await runInitWizard({
      prompt,
      probe: (_, env) => {
        probeEnvs.push({ ...env });
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    // Probe sees the bundled key so validation exercises real credentials
    expect(probeEnvs[0].TRELLO_API_KEY).toBe(BUNDLED_TRELLO_API_KEY);
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain(`TRELLO_API_KEY=${BUNDLED_TRELLO_API_KEY}`);
    expect(env).toContain("TRELLO_API_TOKEN=trello-token");
  });

  test("markdown tracker: no probe, defaults tasks dir", async () => {
    let probed = false;
    const { prompt } = promptQueue([
      "markdown",
      "", // accept ./tasks default
      "", // skip PR token
    ]);

    await runInitWizard({
      prompt,
      probe: () => {
        probed = true;
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(probed).toBe(false);
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("TASK_TRACKER=markdown");
    expect(env).toContain("MARKDOWN_TASKS_DIR=./tasks");
  });

  test("github tracker skips the extra PR-token step", async () => {
    const { prompt, remaining } = promptQueue([
      "github",
      "ghp_token",
      "acme/widgets",
      "", // skip status labels
    ]);

    await runInitWizard({ prompt, probe: () => Promise.resolve(), cwd: tempDir, log: silentLog });

    expect(remaining).toHaveLength(0);
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("GITHUB_TOKEN=ghp_token");
    expect(env).toContain("GITHUB_REPO=acme/widgets");
  });

  test("PR token answer is written for non-github trackers", async () => {
    const { prompt } = promptQueue([
      "linear",
      "lin_api_123",
      "", // skip team key
      "ghp_pr_token",
    ]);

    await runInitWizard({ prompt, probe: () => Promise.resolve(), cwd: tempDir, log: silentLog });

    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("GITHUB_TOKEN=ghp_pr_token");
  });

  test("refuses when .devintern-code already exists without prompting", async () => {
    scaffoldProject({ cwd: tempDir });
    const { prompt, asked } = promptQueue([]);
    await runInitWizard({ prompt, probe: () => Promise.resolve(), cwd: tempDir, log: silentLog });
    expect(asked).toHaveLength(0);
  });
});

describe("init --yes subprocess", () => {
  test("writes the template files without prompting", () => {
    const result = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "init", "--yes"],
      {
        cwd: tempDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    const env = readFileSync(join(tempDir, ".devintern-code", ".env"), "utf8");
    expect(env).toContain("TASK_TRACKER=jira");
    expect(env).toContain("# LINEAR_API_KEY=");
  });
});
