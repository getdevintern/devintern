import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_TRELLO_API_KEY } from "@devintern/task-trackers";
import {
  PM_TRACKER_DOCS,
  PM_TRACKER_SETUP,
  isInteractive,
  renderPmEnvFile,
  runPmInitWizard,
} from "./lib/init-wizard";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pm-init-wizard-test-"));
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
const okProbe = () => Promise.resolve();

function readEnv(): string {
  return readFileSync(join(tempDir, ".devintern-pm", ".env"), "utf8");
}

describe("isInteractive", () => {
  test("true only for a TTY without escape flags", () => {
    expect(isInteractive(["bun", "cli", "init"], { isTTY: true })).toBe(true);
    expect(isInteractive(["bun", "cli", "init"], { isTTY: undefined })).toBe(false);
    expect(isInteractive(["bun", "cli", "init", "--yes"], { isTTY: true })).toBe(false);
    expect(isInteractive(["bun", "cli", "init", "--no-interactive"], { isTTY: true })).toBe(false);
  });
});

describe("PM_TRACKER_SETUP", () => {
  test("covers every tracker in the backends registry", () => {
    expect(Object.keys(PM_TRACKER_SETUP).sort()).toEqual(
      ["asana", "azure-devops", "github", "jira", "linear", "markdown", "trello"].sort(),
    );
  });

  test("every non-markdown tracker links to a devintern.com setup guide", () => {
    for (const trackerId of Object.keys(PM_TRACKER_SETUP)) {
      if (trackerId === "markdown") continue;
      expect(PM_TRACKER_DOCS[trackerId]).toStartWith("https://devintern.com/docs/pm/");
    }
  });
});

describe("renderPmEnvFile", () => {
  test("writes TASK_TRACKER, provided values, docs link, and comments out skipped optionals", () => {
    const env = renderPmEnvFile("linear", { LINEAR_API_KEY: "lin_api_123" });
    expect(env).toContain("TASK_TRACKER=linear");
    expect(env).toContain("LINEAR_API_KEY=lin_api_123");
    expect(env).toContain("# LINEAR_DEFAULT_TEAM_KEY=ENG");
    expect(env).toContain("# Setup guide: https://devintern.com/docs/pm/linear-integration");
    expect(env).toContain("AGENT_HARNESS=claude-code");
  });
});

describe("runPmInitWizard", () => {
  test("jira happy path writes .env and updates .gitignore", async () => {
    const { prompt, remaining } = promptQueue([
      "1", // jira
      "https://acme.atlassian.net",
      "dev@acme.com",
      "secret-token",
      "PROJ",
    ]);
    await runPmInitWizard({ prompt, probe: okProbe, cwd: tempDir, log: silentLog });

    expect(remaining).toHaveLength(0);
    const env = readEnv();
    expect(env).toContain("TASK_TRACKER=jira");
    expect(env).toContain("JIRA_BASE_URL=https://acme.atlassian.net");
    expect(env).toContain("JIRA_EMAIL=dev@acme.com");
    expect(env).toContain("JIRA_API_TOKEN=secret-token");
    expect(env).toContain("JIRA_DEFAULT_PROJECT_KEY=PROJ");
    expect(env).toContain("# Setup guide: https://devintern.com/docs/pm/jira-integration");

    const gitignore = readFileSync(join(tempDir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".devintern-pm/.env");
    expect(gitignore).toContain(".devintern-pm/.auth-session.json");
  });

  test("prints the setup guide and token deep link", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue(["jira", "https://acme.atlassian.net", "d@a.com", "tok", "P"]);
    await runPmInitWizard({ prompt, probe: okProbe, cwd: tempDir, log: (m) => logs.push(m) });

    const output = logs.join("\n");
    expect(output).toContain("https://devintern.com/docs/pm/jira-integration");
    expect(output).toContain("https://id.atlassian.com/manage-profile/security/api-tokens");
  });

  test("trello defaults to the bundled API key and embeds it in the authorize link", async () => {
    const logs: string[] = [];
    const { prompt } = promptQueue([
      "trello",
      "", // API key -> bundled default
      "trello-token",
      "", // board id skipped
      "", // list name skipped
    ]);
    await runPmInitWizard({ prompt, probe: okProbe, cwd: tempDir, log: (m) => logs.push(m) });

    const env = readEnv();
    expect(env).toContain(`TRELLO_API_KEY=${BUNDLED_TRELLO_API_KEY}`);
    expect(env).toContain("TRELLO_API_TOKEN=trello-token");
    expect(env).toContain("# TRELLO_DEFAULT_BOARD_ID=abc123");
    expect(logs.join("\n")).toContain(`key=${BUNDLED_TRELLO_API_KEY}`);
  });

  test("markdown tracker skips probing and applies the default directory", async () => {
    let probed = false;
    const { prompt } = promptQueue(["markdown", ""]);
    await runPmInitWizard({
      prompt,
      probe: () => {
        probed = true;
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    expect(probed).toBe(false);
    expect(readEnv()).toContain("MARKDOWN_TASKS_DIR=.devintern-pm/tasks");
  });

  test("failed probe offers edit then succeeds with corrected values", async () => {
    const seen: string[] = [];
    const probe = (_: string, env: Record<string, string>) => {
      seen.push(env.LINEAR_API_KEY ?? "");
      return env.LINEAR_API_KEY === "good" ? Promise.resolve() : Promise.reject(new Error("401"));
    };
    const { prompt } = promptQueue([
      "linear",
      "bad", // first key
      "", // team key skipped
      "e", // edit after failure
      "good", // corrected key
      "", // team key skipped again
    ]);
    await runPmInitWizard({ prompt, probe, cwd: tempDir, log: silentLog });

    expect(seen).toEqual(["bad", "good"]);
    expect(readEnv()).toContain("LINEAR_API_KEY=good");
  });

  test("skip validation writes values as-is", async () => {
    const { prompt } = promptQueue(["github", "ghp_bad", "acme/app", "s"]);
    await runPmInitWizard({
      prompt,
      probe: () => Promise.reject(new Error("401")),
      cwd: tempDir,
      log: silentLog,
    });

    const env = readEnv();
    expect(env).toContain("GITHUB_TOKEN=ghp_bad");
    expect(env).toContain("GITHUB_REPO=acme/app");
  });

  test("fast track: reuses .devintern-code credentials and only prompts for missing required steps", async () => {
    mkdirSync(join(tempDir, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(tempDir, ".devintern-code", ".env"),
      [
        "TASK_TRACKER=jira",
        "JIRA_BASE_URL=https://acme.atlassian.net",
        "JIRA_EMAIL=dev@acme.com",
        "JIRA_API_TOKEN=secret-token",
        "# JIRA_DEFAULT_PROJECT_KEY is not set in the code config",
      ].join("\n"),
      "utf8",
    );

    const probeEnvs: Array<Record<string, string>> = [];
    const { prompt, asked } = promptQueue([
      "", // accept reuse (default Y)
      "PROJ", // missing required project key
    ]);
    await runPmInitWizard({
      prompt,
      probe: (_, env) => {
        probeEnvs.push({ ...env });
        return Promise.resolve();
      },
      cwd: tempDir,
      log: silentLog,
    });

    // No tracker menu, no re-prompt for credentials already in the code config.
    expect(asked.some((q) => q.includes("Enter a number"))).toBe(false);
    expect(probeEnvs[0]?.JIRA_API_TOKEN).toBe("secret-token");
    const env = readEnv();
    expect(env).toContain("TASK_TRACKER=jira");
    expect(env).toContain("JIRA_BASE_URL=https://acme.atlassian.net");
    expect(env).toContain("JIRA_API_TOKEN=secret-token");
    expect(env).toContain("JIRA_DEFAULT_PROJECT_KEY=PROJ");
  });

  test("fast track: declining reuse falls back to the normal flow", async () => {
    mkdirSync(join(tempDir, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(tempDir, ".devintern-code", ".env"),
      "TASK_TRACKER=linear\nLINEAR_API_KEY=lin_api_old\n",
      "utf8",
    );

    const { prompt, asked } = promptQueue([
      "n", // decline reuse
      "github",
      "ghp_new",
      "acme/app",
    ]);
    await runPmInitWizard({ prompt, probe: okProbe, cwd: tempDir, log: silentLog });

    expect(asked.some((q) => q.includes("Enter a number"))).toBe(true);
    const env = readEnv();
    expect(env).toContain("TASK_TRACKER=github");
    expect(env).toContain("GITHUB_TOKEN=ghp_new");
    expect(env).not.toContain("lin_api_old");
  });

  test("declining the overwrite prompt leaves the existing .env untouched", async () => {
    const first = promptQueue(["jira", "https://a.b", "d@a.com", "tok", "P"]);
    await runPmInitWizard({ prompt: first.prompt, probe: okProbe, cwd: tempDir, log: silentLog });
    const before = readEnv();

    const second = promptQueue(["n"]);
    await runPmInitWizard({ prompt: second.prompt, probe: okProbe, cwd: tempDir, log: silentLog });

    expect(readEnv()).toBe(before);
    expect(second.remaining).toHaveLength(0);
  });

  test("accepting the overwrite prompt reconfigures", async () => {
    const first = promptQueue(["jira", "https://a.b", "d@a.com", "tok", "P"]);
    await runPmInitWizard({ prompt: first.prompt, probe: okProbe, cwd: tempDir, log: silentLog });

    const second = promptQueue(["y", "linear", "lin_api_1", ""]);
    await runPmInitWizard({ prompt: second.prompt, probe: okProbe, cwd: tempDir, log: silentLog });

    expect(readEnv()).toContain("TASK_TRACKER=linear");
    expect(existsSync(join(tempDir, ".devintern-pm", ".env"))).toBe(true);
  });
});
