/**
 * Reusing the GitHub CLI session as `GITHUB_TOKEN`: the fake `gh` reader, the
 * interactive offer with its probe gate, and the non-interactive automatic
 * use and rejection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  describeGitHubCliToken,
  parseGitHubCliStatus,
  readGitHubCliToken,
} from "../src/lib/init/github-cli-token";
import { runNonInteractiveWorkerInit } from "../src/lib/init/worker-init-noninteractive";
import type { NonInteractiveInitDeps } from "../src/lib/init/worker-init-noninteractive";
import { renderNonInteractiveReport } from "../src/lib/init/worker-init-noninteractive-text";
import { runTrackerSetup } from "../src/lib/init/wizard";

const TOKEN = "gho_fake_github_cli_token";

/** A fake `gh` binary whose two subcommands answer as told. */
function fakeGh(
  options: { token?: string; status?: string; signedOut?: boolean },
  parent = tmpdir(),
): string {
  const dir = mkdtempSync(join(parent, "fake-gh-"));
  const script = `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
${
  options.signedOut
    ? "  echo 'You are not logged into any GitHub hosts.' >&2\n  exit 1"
    : `  echo '${options.token ?? TOKEN}'\n  exit 0`
}
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  cat <<'EOF'
${options.status ?? ""}
EOF
  exit 0
fi
exit 1
`;
  writeFileSync(join(dir, "gh"), script);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

const STATUS = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Token scopes: 'repo', 'read:org'`;

describe("readGitHubCliToken", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  test("reuses the token and reads the account and scopes", () => {
    const dir = fakeGh({ status: STATUS });
    dirs.push(dir);
    expect(readGitHubCliToken({ env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } })).toEqual({
      token: TOKEN,
      account: "octocat",
      scopes: "repo, read:org",
    });
  });

  test("returns null when gh is absent", () => {
    expect(readGitHubCliToken({ env: { ...process.env, PATH: "" } })).toBeNull();
  });

  test("returns null when gh is not signed in", () => {
    const dir = fakeGh({ signedOut: true });
    dirs.push(dir);
    expect(
      readGitHubCliToken({ env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } }),
    ).toBeNull();
  });

  test("parses the older `as <user>` status wording", () => {
    expect(
      parseGitHubCliStatus(`✓ Logged in to github.com as monalisa (keyring)
  - Token scopes: 'repo'`),
    ).toEqual({ account: "monalisa", scopes: "repo" });
  });

  test("describes the session without the token", () => {
    const text = describeGitHubCliToken({ token: TOKEN, account: "octocat", scopes: "repo" });
    expect(text).toBe("account octocat, scopes repo");
    expect(text).not.toContain(TOKEN);
  });
});

describe("interactive setup", () => {
  let root: string;
  let cwd: string;
  let logs: string[];
  const saved = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_REPO: process.env.GITHUB_REPO,
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gh-token-wizard-"));
    cwd = join(root, "repo");
    mkdirSync(cwd, { recursive: true });
    logs = [];
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
  });

  afterEach(() => {
    if (saved.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
    if (saved.GITHUB_REPO === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = saved.GITHUB_REPO;
    rmSync(root, { recursive: true, force: true });
  });

  /** Answer the tracker menu and the credential prompts from one handler. */
  async function setup(
    answers: (question: string) => string,
    overrides: {
      token?: { token: string; account?: string; scopes?: string } | null;
      probe?: (trackerId: string, env: Record<string, string>) => Promise<void>;
    } = {},
  ): Promise<{ env: string; questions: string[]; probeEnvs: Record<string, string>[] }> {
    const questions: string[] = [];
    const probeEnvs: Record<string, string>[] = [];
    let env = "";
    await runTrackerSetup(
      async (question) => {
        questions.push(question);
        return answers(question);
      },
      (message) => logs.push(message),
      async (trackerId, values) => {
        probeEnvs.push({ ...values });
        await overrides.probe?.(trackerId, values);
      },
      cwd,
      {
        githubCliToken: () => overrides.token ?? null,
        writeEnv: async (content) => {
          env = content;
          return join(root, "repo.env");
        },
      },
    );
    return { env, questions, probeEnvs };
  }

  function answer(question: string): string {
    if (question.startsWith("Enter a number")) return "github";
    if (question.startsWith("Use your GitHub CLI token")) return "";
    if (question.startsWith("GitHub personal access token")) return "ghp_pasted";
    if (question.startsWith("Target repository")) return "acme/app";
    if (question.startsWith("What next?")) return "s";
    return "";
  }

  test("offers a signed-in token and skips the token prompt", async () => {
    const { env, questions, probeEnvs } = await setup(answer, {
      token: { token: TOKEN, account: "octocat", scopes: "repo, read:org" },
    });
    expect(
      questions.some((question) =>
        question.startsWith(
          "Use your GitHub CLI token (account octocat, scopes repo, read:org)? [Y/n]",
        ),
      ),
    ).toBe(true);
    expect(questions.some((question) => question.startsWith("GitHub personal access token"))).toBe(
      false,
    );
    expect(probeEnvs.some((values) => values.GITHUB_TOKEN === TOKEN)).toBe(true);
    expect(env).toContain(`GITHUB_TOKEN=${TOKEN}`);
    expect(env).toContain("GITHUB_REPO=acme/app");
    expect(logs.join("\n")).toContain("Using your GitHub CLI token (account octocat");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  test("a token the probe rejects is not offered and the token prompt remains", async () => {
    const { env, questions } = await setup(answer, {
      token: { token: TOKEN, account: "octocat" },
      probe: async (_trackerId, values) => {
        if (values.GITHUB_TOKEN === TOKEN)
          throw new Error("GitHub API error (401): Bad credentials");
      },
    });
    expect(questions.some((question) => question.startsWith("Use your GitHub CLI token"))).toBe(
      false,
    );
    expect(questions.some((question) => question.startsWith("GitHub personal access token"))).toBe(
      true,
    );
    expect(env).toContain("GITHUB_TOKEN=ghp_pasted");
    expect(env).not.toContain(TOKEN);
    expect(logs.join("\n")).toContain("Not using the GitHub CLI token");
  });

  test("offers the token for PRs when the tracker is not GitHub", async () => {
    const { env, questions } = await setup(
      (question) => {
        if (question.startsWith("Enter a number")) return "markdown";
        if (question.startsWith("Directory containing markdown")) return "./tasks";
        return answer(question);
      },
      { token: { token: TOKEN, account: "octocat", scopes: "repo" } },
    );
    expect(questions.some((question) => question.startsWith("Use your GitHub CLI token"))).toBe(
      true,
    );
    expect(questions.some((question) => question.startsWith("GitHub token for creating"))).toBe(
      false,
    );
    expect(env).toContain("TASK_TRACKER=markdown");
    expect(env).toContain(`GITHUB_TOKEN=${TOKEN}`);
  });

  test("declining the offer preserves the normal prompt", async () => {
    const { env, questions } = await setup(
      (question) => (question.startsWith("Use your GitHub CLI token") ? "n" : answer(question)),
      { token: { token: TOKEN, account: "octocat" } },
    );
    expect(questions.some((question) => question.startsWith("GitHub personal access token"))).toBe(
      true,
    );
    expect(env).toContain("GITHUB_TOKEN=ghp_pasted");
    expect(env).not.toContain(TOKEN);
  });
});

describe("non-interactive setup", () => {
  let root: string;
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gh-token-init-"));
    workspaceDir = join(root, "workspace");
    repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    execSync("git init -q -b main && git remote add origin git@github.com:acme/app.git", {
      cwd: repoDir,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(
    deps: Partial<NonInteractiveInitDeps> = {},
    env: Record<string, string> = {},
    overrides: { tracker?: string; taskQuery?: string } = {},
  ): ReturnType<typeof runNonInteractiveWorkerInit> {
    return runNonInteractiveWorkerInit(
      {
        tracker: "github",
        taskQuery: "is:open label:devintern",
        repoFromCwd: true,
        json: true,
        yes: false,
        ...overrides,
      },
      {
        cwd: repoDir,
        workspaceDir,
        processEnv: env,
        probe: async () => {},
        probeTimeoutMs: 2_000,
        doctor: {
          dryRunQuery: async () => 1,
          checkRepoAccess: async () => ({ ok: true, detail: "readable" }),
          checkEntitlement: async () => ({ valid: true, source: "license-key", message: "ok" }),
          checkHarness: async () => ({ id: "harness", label: "Agent harness", status: "ok" }),
          checkSandbox: async () => ({ id: "sandbox", label: "Agent sandbox", status: "ok" }),
          checkGitIdentity: async () => ({ id: "git-identity", label: "Git", status: "ok" }),
          isPortInUse: async () => false,
          workerStatus: () => ({ status: "stopped" }),
        },
        ...deps,
      },
    );
  }

  test("uses and saves the gh token automatically, reporting tokenSource", async () => {
    const report = await run({ githubCliToken: () => ({ token: TOKEN, account: "octocat" }) });
    expect(report.result).toBe("success");
    expect(report.tokenSource).toBe("gh");
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain(`GITHUB_TOKEN=${TOKEN}`);
    const text = renderNonInteractiveReport(report).join("\n");
    expect(text).toContain("GitHub token from the GitHub CLI (`gh auth token`)");
    expect(text).not.toContain(TOKEN);
  });

  test("without gh or an environment token, github setup is missing_input", async () => {
    const report = await run({ githubCliToken: () => null });
    expect(report.result).toBe("failure");
    expect(report.code).toBe("missing_input");
    expect(report.missing).toContain("GITHUB_TOKEN");
  });

  test("a GitHub remote for PRs also reuses gh when the tracker is not GitHub", async () => {
    const report = await run(
      {
        githubCliToken: () => ({ token: TOKEN, account: "octocat" }),
      },
      {
        JIRA_BASE_URL: "https://acme.atlassian.net",
        JIRA_EMAIL: "bot@acme.test",
        JIRA_API_TOKEN: "ATATT-test-token",
      },
      { tracker: "jira", taskQuery: "project = APP" },
    );
    expect(report.result).toBe("success");
    expect(report.tokenSource).toBe("gh");
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain(`GITHUB_TOKEN=${TOKEN}`);
  });

  test("a rejected gh token for a GitHub remote fails with fix-credentials", async () => {
    // The real reader over a fake `gh` on PATH, plus a probe that rejects it.
    const ghDir = fakeGh({ status: STATUS }, root);
    const report = await run(
      {
        githubCliToken: () =>
          readGitHubCliToken({ env: { ...process.env, PATH: `${ghDir}:/usr/bin:/bin` } }),
        probe: async (trackerId, env) => {
          if (trackerId === "github" && env.GITHUB_TOKEN === TOKEN) {
            throw new Error("GitHub API error (401): Bad credentials");
          }
        },
      },
      {
        JIRA_BASE_URL: "https://acme.atlassian.net",
        JIRA_EMAIL: "bot@acme.test",
        JIRA_API_TOKEN: "ATATT-test-token",
      },
      { tracker: "jira", taskQuery: "project = APP" },
    );
    expect(report.result).toBe("failure");
    expect(report.code).toBe("credentials_rejected");
    expect(report.persisted).toBe(false);
    expect(report.tokenSource).toBeUndefined();
    expect(report.nextSteps.map((step) => step.id)).toContain("fix-credentials");
    expect(
      report.warnings.some((warning) => warning.includes("GitHub CLI token was rejected")),
    ).toBe(true);
    const envPath = join(workspaceDir, ".env");
    const saved = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    expect(saved).not.toContain(TOKEN);
    expect(renderNonInteractiveReport(report).join("\n")).not.toContain(
      "GitHub token from the GitHub CLI",
    );
  });

  test("a rejection that is not repeated by the readiness probe still fails", async () => {
    let probes = 0;
    const report = await run({
      githubCliToken: () => ({ token: TOKEN, account: "octocat" }),
      probe: async () => {
        probes += 1;
        if (probes === 1) throw new Error("GitHub API error (401): Bad credentials");
      },
    });
    expect(probes).toBe(2);
    expect(report.result).toBe("failure");
    expect(report.code).toBe("credentials_rejected");
    expect(report.persisted).toBe(false);
    expect(report.tokenSource).toBeUndefined();
    expect(report.nextSteps.map((step) => step.id)).toContain("fix-credentials");
    expect(report.checks.find((check) => check.name === "credentials")?.status).toBe("fail");
    const envPath = join(workspaceDir, ".env");
    expect(existsSync(envPath) ? readFileSync(envPath, "utf8") : "").not.toContain(TOKEN);
  });

  test("a rejected gh token is not saved and fails with fix-credentials", async () => {
    const report = await run(
      {
        githubCliToken: () => ({ token: TOKEN, account: "octocat" }),
        probe: async () => {
          throw new Error("GitHub API error (401): Bad credentials");
        },
      },
      {},
    );
    expect(report.result).toBe("failure");
    expect(report.code).toBe("credentials_rejected");
    expect(report.persisted).toBe(false);
    expect(report.tokenSource).toBeUndefined();
    expect(report.nextSteps.map((step) => step.id)).toContain("fix-credentials");
    const envPath = join(workspaceDir, ".env");
    expect(existsSync(envPath) ? readFileSync(envPath, "utf8") : "").not.toContain(TOKEN);
  });

  test("an environment token reports tokenSource env and gh is not read", async () => {
    let reads = 0;
    const report = await run(
      {
        githubCliToken: () => {
          reads += 1;
          return { token: TOKEN };
        },
      },
      { GITHUB_TOKEN: "ghp_from_env" },
    );
    expect(report.result).toBe("success");
    expect(report.tokenSource).toBe("env");
    expect(reads).toBe(0);
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain("GITHUB_TOKEN=ghp_from_env");
  });

  test("an --env-file token reports tokenSource env-file", async () => {
    const envFile = join(root, "creds.env");
    writeFileSync(envFile, "GITHUB_TOKEN=ghp_from_file\n", { mode: 0o600 });
    let reads = 0;
    const report = await runNonInteractiveWorkerInit(
      {
        tracker: "github",
        taskQuery: "is:open label:devintern",
        repoFromCwd: true,
        envFile,
        json: true,
        yes: false,
      },
      {
        cwd: repoDir,
        workspaceDir,
        processEnv: {},
        probe: async () => {},
        probeTimeoutMs: 2_000,
        githubCliToken: () => {
          reads += 1;
          return { token: TOKEN };
        },
        doctor: {
          dryRunQuery: async () => 1,
          checkRepoAccess: async () => ({ ok: true, detail: "readable" }),
          checkEntitlement: async () => ({ valid: true, source: "license-key", message: "ok" }),
          checkHarness: async () => ({ id: "harness", label: "Agent harness", status: "ok" }),
          checkSandbox: async () => ({ id: "sandbox", label: "Agent sandbox", status: "ok" }),
          checkGitIdentity: async () => ({ id: "git-identity", label: "Git", status: "ok" }),
          isPortInUse: async () => false,
          workerStatus: () => ({ status: "stopped" }),
        },
      },
    );
    expect(report.result).toBe("success");
    expect(report.tokenSource).toBe("env-file");
    expect(reads).toBe(0);
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain(
      "GITHUB_TOKEN=ghp_from_file",
    );
  });

  test("a token already saved in the workspace .env reports tokenSource env-file", async () => {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, ".env"), "GITHUB_TOKEN=ghp_workspace\n", { mode: 0o600 });
    let reads = 0;
    const report = await run({
      githubCliToken: () => {
        reads += 1;
        return { token: TOKEN };
      },
    });
    expect(report.result).toBe("success");
    expect(report.tokenSource).toBe("env-file");
    expect(reads).toBe(0);
    expect(readFileSync(join(workspaceDir, ".env"), "utf8")).toContain(
      "GITHUB_TOKEN=ghp_workspace",
    );
  });
});
