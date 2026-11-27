/**
 * Interactive onboarding polish for `devintern worker init`: reusing the
 * tracker settings `devintern init` saved, the recommended settings written
 * without a question (and `--customize`), sign-in skip/stop handling, and readable query errors.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { LoginSkippedError } from "@devintern/auth";

import {
  isPromptAbort,
  isPromptAbortReported,
  promptInterruptedError,
} from "../src/lib/cli/prompt-abort";
import {
  defaultEnsureTracker,
  describeCustomWorkerSettings,
  describeQueryFailure,
  reportWorkerInitAbort,
  runWorkerInit,
} from "../src/lib/init/worker-init";
import { loadWorkspaceConfig } from "../src/lib/workspace/config";

const RECOMMENDED = "Use the recommended worker settings";

describe("worker init onboarding", () => {
  let tempDir: string;
  let workspaceDir: string;
  let logs: string[];
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "TASK_TRACKER",
    "DEVINTERN_WORKSPACE_DIR",
    "GITHUB_TOKEN",
    "GITHUB_REPO",
    "LICENSE_KEY",
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-worker-onboarding-"));
    workspaceDir = path.join(tempDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      path.join(workspaceDir, "workspace.toml"),
      '[defaults]\ntracker = "markdown"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n',
    );
    process.env.TASK_TRACKER = "markdown";
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    delete process.env.LICENSE_KEY;
    logs = [];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Hermetic wizard deps; `answer` maps each question to a reply. */
  function deps(
    answer: (question: string) => string,
    overrides: Partial<Parameters<typeof runWorkerInit>[0]> = {},
  ) {
    const questions: string[] = [];
    return {
      questions,
      deps: {
        cwd: tempDir,
        log: (message: string) => logs.push(message),
        prompt: async (question: string) => {
          questions.push(question);
          return question.startsWith("Ready-tasks query") ? "status=todo" : answer(question);
        },
        ensureTracker: async () => "markdown",
        bootstrapWorkspace: async () => ({ workspaceDir, repoName: "app" }),
        githubCliToken: () => null,
        detectGithubRepo: async () => null,
        noService: true,
        getUser: async () => null,
        // Never the real browser sign-in.
        signIn: async () => null,
        ...overrides,
      },
    };
  }

  describe("recommended worker settings", () => {
    test("a new workspace gets the recommended settings without a question", async () => {
      const { questions, deps: d } = deps(() => "");
      const result = await runWorkerInit(d);
      expect(result.ok).toBe(true);
      expect(questions.some((question) => question.startsWith(RECOMMENDED))).toBe(false);
      for (const skipped of [
        "worker settings",
        "repair failing CI",
        "Conflict handling",
        "active hours",
        "Sentry project",
      ]) {
        expect(questions.some((question) => question.includes(skipped))).toBe(false);
      }
      expect(logs.join("\n")).toContain(
        "💾 Wrote the recommended worker settings to workspace.toml (",
      );
      expect(logs.join("\n")).toContain("`devintern worker init --customize`");
      const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
      expect(config.workspace.ciFailureFix).toBe(false);
      expect(config.workspace.conflictResolution).toBe("auto");
      expect(config.worker.schedule).toBeNull();
      expect(config.errorMonitors).toHaveLength(0);
      const toml = readFileSync(path.join(workspaceDir, "workspace.toml"), "utf8");
      expect(toml).toContain("ci_failure_fix = false");
    });

    test("--customize walks through the expanded questions", async () => {
      const { questions, deps: d } = deps(() => "", { customize: true });
      const result = await runWorkerInit(d);
      expect(result.ok).toBe(true);
      expect(questions.some((question) => question.startsWith(RECOMMENDED))).toBe(false);
      expect(questions.some((question) => question.includes("repair failing CI"))).toBe(true);
      expect(questions.some((question) => question.includes("Conflict handling"))).toBe(true);
      expect(questions.some((question) => question.includes("active hours"))).toBe(true);
      expect(questions.some((question) => question.includes("Sentry project"))).toBe(true);
    });

    test("customized settings are kept without a question", async () => {
      writeFileSync(
        path.join(workspaceDir, "workspace.toml"),
        '[workspace]\nci_failure_fix = true\n\n[defaults]\ntracker = "markdown"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\n\n[worker.schedule]\nactive = ["22:00-06:00"]\n',
      );
      const { questions, deps: d } = deps(() => "");
      await runWorkerInit(d);
      expect(questions.some((question) => question.includes("worker settings"))).toBe(false);
      expect(logs.join("\n")).toContain(
        "Kept the current worker settings (CI repair on, active hours 22:00-06:00)",
      );
      const config = loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml"));
      expect(config.workspace.ciFailureFix).toBe(true);
      expect(config.worker.schedule?.active.map((window) => window.spec)).toEqual(["22:00-06:00"]);
    });

    test("describeCustomWorkerSettings is null for the defaults", () => {
      writeFileSync(
        path.join(workspaceDir, "workspace.toml"),
        '[defaults]\ntracker = "markdown"\n',
      );
      expect(
        describeCustomWorkerSettings(
          loadWorkspaceConfig(path.join(workspaceDir, "workspace.toml")),
        ),
      ).toBeNull();
    });
  });

  describe("sign-in", () => {
    test("a skipped Pilot sign-in continues setup and the relay does not ask again", async () => {
      let signIns = 0;
      const { questions, deps: d } = deps(() => "", {
        checkAutomationLicense: async () => "No automation license found.",
        signIn: async () => {
          signIns += 1;
          throw new LoginSkippedError();
        },
      });
      const result = await runWorkerInit(d);
      expect(result.ok).toBe(true);
      expect(signIns).toBe(1);
      const all = logs.join("\n");
      expect(all).toContain("Sign-in skipped. Sign in later with `devintern worker login");
      expect(questions.some((question) => question.includes("connect the relay"))).toBe(false);
      expect(all).toContain("Relay needs sign-in; skipped.");
    });

    test("Ctrl+C during sign-in says what was saved and how to continue", async () => {
      const { deps: d } = deps(() => "", {
        checkAutomationLicense: async () => "No automation license found.",
        signIn: async () => {
          throw promptInterruptedError();
        },
      });
      const error = await runWorkerInit(d).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(isPromptAbort(error)).toBe(true);
      // The wizard marked it, so the CLI does not add a second "setup stopped" line.
      expect(isPromptAbortReported(error)).toBe(true);
      const cliLines: string[] = [];
      expect(reportWorkerInitAbort(error, (line) => cliLines.push(line))).toBe(1);
      const all = [...logs, ...cliLines].join("\n");
      expect(all).toContain("Setup paused. Your answers so far are saved in");
      expect(all).toContain(path.join(workspaceDir, "workspace.toml"));
      expect(all).toContain("run `devintern worker init` to continue");
      expect(all).not.toContain("setup stopped");
    });

    test("an abort the wizard could not explain gets the generic closing line", () => {
      const cliLines: string[] = [];
      expect(reportWorkerInitAbort(promptInterruptedError(), (line) => cliLines.push(line))).toBe(
        1,
      );
      const all = cliLines.join("\n");
      expect(all).toContain("Interrupted (Ctrl+C); setup stopped. Re-run `devintern worker init`.");
      expect(all).not.toContain("Setup paused");
    });
  });

  describe("GitHub CLI token", () => {
    test("offers a signed-in token for PRs on a GitHub remote and saves it", async () => {
      delete process.env.GITHUB_TOKEN;
      const { questions, deps: d } = deps(() => "", {
        githubCliToken: () => ({
          token: "gho_fake",
          account: "octocat",
          scopes: "repo",
        }),
        githubTokenProbe: async () => {},
      });
      const result = await runWorkerInit(d);
      expect(result.ok).toBe(true);
      expect(
        questions.some((question) =>
          question.startsWith("Use your GitHub CLI token (account octocat, scopes repo)? [Y/n]"),
        ),
      ).toBe(true);
      const env = readFileSync(path.join(workspaceDir, ".env"), "utf8");
      expect(env).toContain("GITHUB_TOKEN=gho_fake");
      expect(logs.join("\n")).not.toContain("gho_fake");
    });

    test("a rejected token is not saved and falls back to the token prompt", async () => {
      delete process.env.GITHUB_TOKEN;
      const { questions, deps: d } = deps(
        (question) =>
          question.startsWith("GitHub token for creating pull requests")
            ? "ghp_pasted_after_reject"
            : "",
        {
          githubCliToken: () => ({ token: "gho_rejected", account: "octocat" }),
          githubTokenProbe: async () => {
            throw new Error("GitHub API error (401): Bad credentials");
          },
        },
      );
      const result = await runWorkerInit(d);
      expect(result.ok).toBe(true);
      expect(
        questions.some((question) =>
          question.startsWith("GitHub token for creating pull requests"),
        ),
      ).toBe(true);
      const env = readFileSync(path.join(workspaceDir, ".env"), "utf8");
      expect(env).not.toContain("gho_rejected");
      expect(env).toContain("GITHUB_TOKEN=ghp_pasted_after_reject");
      expect(logs.join("\n")).toContain("Not using the GitHub CLI token");
    });
    test("a fresh non-GitHub tracker offers the CLI token only once", async () => {
      delete process.env.GITHUB_TOKEN;
      const { questions, deps: d } = deps(
        (question) => (question.startsWith("Enter a number") ? "markdown" : ""),
        {
          ensureTracker: undefined,
          githubCliToken: () => ({ token: "gho_once", account: "octocat", scopes: "repo" }),
          githubTokenProbe: async () => {},
        },
      );
      const result = await runWorkerInit(d);
      expect(result.ok).toBe(true);
      expect(
        questions.filter((question) => question.startsWith("Use your GitHub CLI token")),
      ).toHaveLength(1);
      expect(readFileSync(path.join(workspaceDir, ".env"), "utf8")).toContain(
        "GITHUB_TOKEN=gho_once",
      );
    });
  });

  describe("tracker settings from devintern init", () => {
    function gitCheckout(): string {
      const checkout = path.join(tempDir, "app");
      mkdirSync(checkout, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: checkout });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], {
        cwd: checkout,
      });
      return checkout;
    }

    beforeEach(() => {
      delete process.env.TASK_TRACKER;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPO;
      // What `devintern init` leaves: a manual-only repo with its own env file.
      writeFileSync(
        path.join(workspaceDir, "workspace.toml"),
        '[defaults]\ntracker = "github"\n\n[[repos]]\nname = "app"\nremote = "git@github.com:acme/app.git"\nmanual_only = true\nenv_file = "env/app.env"\n',
      );
      mkdirSync(path.join(workspaceDir, "env"), { recursive: true });
      writeFileSync(path.join(workspaceDir, ".env"), "# shared\n");
    });

    test("reuses ~/.devintern/env/<repo>.env instead of asking again", async () => {
      writeFileSync(
        path.join(workspaceDir, "env", "app.env"),
        "TASK_TRACKER=github\nGITHUB_TOKEN=ghp_from_init\nGITHUB_REPO=acme/app\n",
      );
      const checkout = gitCheckout();
      const stop = async (): Promise<string> => {
        throw new Error("tracker prompt reached");
      };
      const tracker = await defaultEnsureTracker(
        checkout,
        stop,
        stop,
        (m) => logs.push(m),
        () => null,
      );
      expect(tracker).toBe("github");
      const all = logs.join("\n");
      expect(all).toContain(`from ${path.join(workspaceDir, "env", "app.env")}`);
      expect(all).not.toContain("No tracker config yet");
      const shared = readFileSync(path.join(workspaceDir, ".env"), "utf8");
      expect(shared).toContain("GITHUB_REPO=acme/app");
      expect(shared).toContain("TASK_TRACKER=github");
      expect(process.env.GITHUB_REPO).toBe("acme/app");
    });

    test("an env file without the tracker's credentials still runs the tracker setup", async () => {
      writeFileSync(path.join(workspaceDir, "env", "app.env"), "TASK_TRACKER=github\n");
      const checkout = gitCheckout();
      const stop = async (): Promise<string> => {
        throw new Error("tracker prompt reached");
      };
      await expect(
        defaultEnsureTracker(
          checkout,
          stop,
          stop,
          (m) => logs.push(m),
          () => null,
        ),
      ).rejects.toThrow("tracker prompt reached");
      expect(logs.join("\n")).toContain("No tracker config yet");
    });
  });
});

describe("describeQueryFailure", () => {
  test("a GitHub search the token cannot run is an access problem, without raw JSON", () => {
    const failure = describeQueryFailure(
      'GitHub API error (422): {"message":"Validation Failed","errors":[{"message":"The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.","resource":"Search","field":"q","code":"invalid"}],"status":"422"}',
      "acme/private",
    );
    expect(failure.access).toBe(true);
    expect(failure.text).toContain("GitHub can't search acme/private");
    expect(failure.text).not.toContain("{");
  });

  test("a rejected token is an access problem", () => {
    expect(describeQueryFailure("GitHub API error (401): Bad credentials").access).toBe(true);
  });

  test("other JSON errors keep only their messages", () => {
    const failure = describeQueryFailure(
      'GitHub API error (422): {"message":"Validation Failed","errors":[{"message":"Invalid search query"}]}',
    );
    expect(failure.access).toBe(false);
    expect(failure.text).toBe("GitHub API error (422): Validation Failed; Invalid search query");
  });

  test("a plain message passes through", () => {
    expect(describeQueryFailure("syntax error")).toEqual({ text: "syntax error", access: false });
  });
});
