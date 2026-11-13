/**
 * Offline conflict-resolution harness failover.
 *
 * A workspace worker runs a real conflict-resolution job against a temporary
 * bare remote and a loopback GitLab forge. The primary stub prints a
 * recognized usage limit; the fallback resolves the genuine conflict and the
 * worker pushes the same branch with an ordinary `git push`. A second case
 * limits every harness and asserts the job is deferred.
 *
 * The one-shot `devintern resolve-conflicts` case pins the documented
 * first-harness contract: a comma-separated `AGENT_HARNESS` uses only the
 * first entry, and an exhausted primary exits nonzero. This story does not
 * add one-shot multi-harness failover.
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { command, checkedCommand } from "../../helpers/process";
import { FAKE_GITLAB_TOKEN, FakeGitlabForge } from "../../helpers/fake-gitlab-forge";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const cliTest = test.skipIf(!existsSync(cliPath));

const FEATURE_BRANCH = "feature/conflict-pr";
const PROJECT_PATH = "fixture/repo";
const BRANCH_GREETING = 'export const greeting = "Hello, branch!";\n';
const BASE_GREETING = 'export const greeting = "Hello, base!";\n';
const MERGED_GREETING = 'export const greeting = "Hello, merged!";\n';
const PRIMARY_MODEL = "e2e-primary-model";
const FALLBACK_MODEL = "e2e-codex-model";
const LIMIT_LINES = ["Claude usage limit reached", "resets in 1 hour"];
const SECRET_NAMES = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "JIRA_API_TOKEN",
  "JIRA_TOKEN",
  "LINEAR_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "SENTRY_AUTH_TOKEN",
  "TRELLO_TOKEN",
  "ASANA_ACCESS_TOKEN",
  "AZURE_DEVOPS_TOKEN",
];

interface InvocationRecord {
  target: string;
  harness: string;
  chain: string;
  workerChild: string;
  home: string;
  xdg: string;
  queue: string;
  output: string;
  workspace: string;
  model: string;
  gitlabToken: string;
  conflictPrompt: string;
  secrets: string[];
}

interface FailoverStubs {
  primaryPath: string;
  fallbackPath: string;
  primaryInvocations: string;
  fallbackInvocations: string;
}

interface ConflictHarness {
  worker: WorkerFixture;
  forge: FakeGitlabForge;
  realGit: string;
  gitLog: string;
  stubs: FailoverStubs;
  headSha: string;
  /** Target-branch tip. Second parent of the pushed merge. */
  baseSha: string;
  /** Divergence commit. GitLab `diff_refs.base_sha`, and the processed sync id. */
  mergeBaseSha: string;
  /** Git-wrapper lines written before the worker or one-shot command starts. */
  gitBaseline: number;
}

/** Quote a string for a POSIX single-quoted shell literal. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeStub(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Record harness pinning and isolation without values of ambient secrets. */
function recordInvocation(logPath: string): string[] {
  const secretChecks = SECRET_NAMES.map(
    (name) => `if [ -n "\${${name}-}" ]; then printf '%s\\n' 'secret=${name}'; fi`,
  );
  return [
    "{",
    `  printf '%s\\n' "target=$0"`,
    `  printf '%s\\n' "harness=\${AGENT_HARNESS-}"`,
    `  printf '%s\\n' "chain=\${DEVINTERN_HARNESS_CHAIN-}"`,
    `  printf '%s\\n' "worker_child=\${DEVINTERN_WORKER_CHILD-}"`,
    `  printf '%s\\n' "home=\${HOME-}"`,
    `  printf '%s\\n' "xdg=\${XDG_CONFIG_HOME-}"`,
    `  printf '%s\\n' "queue=\${WEBHOOK_QUEUE_DB-}"`,
    `  printf '%s\\n' "output=\${DEVINTERN_OUTPUT_DIR-}"`,
    `  printf '%s\\n' "workspace=\${DEVINTERN_WORKSPACE_DIR-}"`,
    "  model=",
    "  prev=",
    "  conflict_prompt=0",
    '  for arg in "$@"; do',
    '    if [ "$prev" = "--model" ]; then model=$arg; fi',
    '    case "$arg" in',
    '      *"# Resolve Merge Conflicts"*) conflict_prompt=1 ;;',
    "    esac",
    "    prev=$arg",
    "  done",
    "  printf '%s\\n' \"model=$model\"",
    "  printf '%s\\n' \"conflict_prompt=$conflict_prompt\"",
    '  case "${GITLAB_CODE_HOST_TOKEN-}" in',
    `    ${shQuote(FAKE_GITLAB_TOKEN)}) printf '%s\\n' 'gitlab_token=fixture' ;;`,
    "    '') printf '%s\\n' 'gitlab_token=absent' ;;",
    "    *) printf '%s\\n' 'gitlab_token=unexpected' ;;",
    "  esac",
    ...secretChecks.map((line) => `  ${line}`),
    "  printf '%s\\n' '---'",
    `} >> ${shQuote(logPath)}`,
  ];
}

function createLimitStub(dir: string, name: string, invocations: string): string {
  const path = join(dir, name);
  writeStub(path, [
    "#!/bin/sh",
    ...recordInvocation(invocations),
    `printf '%s\\n' ${LIMIT_LINES.map((line) => shQuote(line)).join(" ")} >&2`,
    "exit 1",
  ]);
  return path;
}

function createDelegateStub(
  dir: string,
  name: string,
  invocations: string,
  agentPath: string,
): string {
  const path = join(dir, name);
  writeStub(path, [
    "#!/bin/sh",
    ...recordInvocation(invocations),
    `exec ${shQuote(process.execPath)} ${shQuote(agentPath)} "$@"`,
  ]);
  return path;
}

/**
 * Point the chain at local stubs and clear `AGENT_CLI_PATH`.
 *
 * The fixture pins that global override at the fake agent. Env-driven
 * resolution prefers it over every `<HARNESS>_CLI_PATH`, which would send
 * the codex retry back to the primary.
 */
function configureFailover(
  worker: WorkerFixture,
  fallbackBehavior: "delegate" | "limit",
): FailoverStubs {
  const dir = join(worker.root, "harness-stubs");
  mkdirSync(dir, { recursive: true });
  const primaryInvocations = join(dir, "claude-code-invocations.txt");
  const fallbackInvocations = join(dir, "codex-invocations.txt");
  const primaryPath = createLimitStub(dir, "claude-code-limit.sh", primaryInvocations);
  const fallbackPath =
    fallbackBehavior === "limit"
      ? createLimitStub(dir, "codex-limit.sh", fallbackInvocations)
      : createDelegateStub(
          dir,
          "codex-delegate.sh",
          fallbackInvocations,
          join(worker.root, "agent.ts"),
        );
  delete worker.env.AGENT_CLI_PATH;
  worker.env.AGENT_HARNESS = "claude-code,codex";
  worker.env.AGENT_MODEL = PRIMARY_MODEL;
  worker.env.CODEX_MODEL = FALLBACK_MODEL;
  worker.env.CLAUDE_CODE_CLI_PATH = primaryPath;
  worker.env.CODEX_CLI_PATH = fallbackPath;
  return { primaryPath, fallbackPath, primaryInvocations, fallbackInvocations };
}

function readInvocations(path: string): InvocationRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("---\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const fields = new Map<string, string>();
      const secrets: string[] = [];
      for (const line of block.split("\n")) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === "secret") secrets.push(value);
        else fields.set(key, value);
      }
      return {
        target: fields.get("target") ?? "",
        harness: fields.get("harness") ?? "",
        chain: fields.get("chain") ?? "",
        workerChild: fields.get("worker_child") ?? "",
        home: fields.get("home") ?? "",
        xdg: fields.get("xdg") ?? "",
        queue: fields.get("queue") ?? "",
        output: fields.get("output") ?? "",
        workspace: fields.get("workspace") ?? "",
        model: fields.get("model") ?? "",
        gitlabToken: fields.get("gitlab_token") ?? "",
        conflictPrompt: fields.get("conflict_prompt") ?? "",
        secrets,
      };
    });
}

function gitLines(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

function pushLines(logPath: string, baseline: number): string[] {
  return gitLines(logPath)
    .slice(baseline)
    .filter((line) => line === "push" || line.startsWith("push "));
}

function revParse(realGit: string, gitDir: string, branch: string): string {
  const result = spawnSync(realGit, ["--git-dir", gitDir, "rev-parse", `refs/heads/${branch}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git rev-parse failed for ${branch}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Commit where the two branch tips diverged. GitLab reports this as `base_sha`. */
function mergeBase(realGit: string, gitDir: string, left: string, right: string): string {
  const result = spawnSync(
    realGit,
    ["--git-dir", gitDir, "merge-base", `refs/heads/${left}`, `refs/heads/${right}`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git merge-base failed for ${left} and ${right}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Parent SHAs of `branch`, in the order `git rev-list --parents` prints them. */
function commitParents(realGit: string, gitDir: string, branch: string): string[] {
  const result = spawnSync(
    realGit,
    ["--git-dir", gitDir, "rev-list", "--parents", "-n", "1", `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git rev-list failed for ${branch}: ${result.stderr}`);
  }
  const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) {
    throw new Error(`git rev-list returned no commit for ${branch}`);
  }
  return ids.slice(1);
}

function parentCount(realGit: string, gitDir: string, branch: string): number {
  return commitParents(realGit, gitDir, branch).length;
}

function showFile(realGit: string, gitDir: string, branch: string, path: string): string {
  const result = spawnSync(realGit, ["--git-dir", gitDir, "show", `refs/heads/${branch}:${path}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout;
}

function processedEvents(dbPath: string): Array<{ source: string; external_id: string }> {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return db.query("SELECT source, external_id FROM processed_events").all() as Array<{
      source: string;
      external_id: string;
    }>;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function syncEventId(baseUrl: string, baseSha: string, headSha: string): string {
  return `sync:${baseUrl}:1!1:${baseSha}:${headSha}`;
}

function redact(text: string): string {
  return text.split(FAKE_GITLAB_TOKEN).join("[redacted]");
}

function bounded(text: string): string {
  return redact(text).split("\n").slice(0, 40).join("\n");
}

async function seedConflict(worker: WorkerFixture, realGit: string): Promise<void> {
  const git = (...args: string[]) => checkedCommand([realGit, ...args], worker.seed, worker.env);
  await git("checkout", "-b", FEATURE_BRANCH);
  writeFileSync(join(worker.seed, "src/greeting.ts"), BRANCH_GREETING);
  await git("add", "src/greeting.ts");
  await git("commit", "-m", "Branch greeting");
  await git("push", "origin", FEATURE_BRANCH);
  await git("checkout", worker.baseBranch);
  writeFileSync(join(worker.seed, "src/greeting.ts"), BASE_GREETING);
  await git("add", "src/greeting.ts");
  await git("commit", "-m", "Base greeting");
  await git("push", "origin", worker.baseBranch);
}

/** Merge the two tips in a throwaway clone and require a real unmerged path. */
async function proveConflict(worker: WorkerFixture, realGit: string): Promise<void> {
  const probe = join(worker.root, "conflict-probe");
  await checkedCommand([realGit, "clone", worker.remote, probe], worker.root, worker.env);
  await checkedCommand([realGit, "-C", probe, "checkout", FEATURE_BRANCH], probe, worker.env);
  const merge = await command(
    [realGit, "-C", probe, "merge", "--no-commit", "--no-ff", worker.baseBranch],
    probe,
    worker.env,
  );
  const greeting = existsSync(join(probe, "src/greeting.ts"))
    ? readFileSync(join(probe, "src/greeting.ts"), "utf8")
    : "";
  rmSync(probe, { recursive: true, force: true });
  if (merge.exitCode === 0 || !greeting.includes("<<<<<<<")) {
    throw new Error(
      `seeded branches did not conflict (merge exit ${merge.exitCode})\n${bounded(
        `${merge.stdout}\n${merge.stderr}`,
      )}`,
    );
  }
}

function patchWorkspace(worker: WorkerFixture, remoteUrl: string): void {
  const path = join(worker.workspaceDir, "workspace.toml");
  const remoteLine = `remote = "${worker.remote}"`;
  let text = readFileSync(path, "utf8");
  if (!text.includes(remoteLine)) {
    throw new Error("workspace remote line was not found");
  }
  text = text.replace(remoteLine, `remote = "${remoteUrl}"`);
  text = text.replace(
    "[workspace]\ndashboard = false\n",
    '[workspace]\ndashboard = false\nci_failure_fix = false\nconflict_resolution = "auto"\n',
  );
  text = text.replace("[defaults]\n", "[defaults]\npoll_interval = 1\n");
  writeFileSync(path, text);
}

/**
 * Log git argv and rewrite the forge URL onto the local bare repository.
 *
 * `git remote get-url` applies `insteadOf` and would show the bare path.
 * The conflict resolver compares that output to the GitLab project, so the
 * wrapper drops the rewrite only for `get-url`. Fetch and push still use it.
 */
function installGitRewrite(worker: WorkerFixture, realGit: string, httpUrl: string): string {
  const dir = join(worker.root, "git-bin");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "git-argv.log");
  const wrapper = join(dir, "git");
  writeStub(wrapper, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${shQuote(logPath)}`,
    "prev=",
    "strip=0",
    'for arg in "$@"; do',
    '  if [ "$prev" = "remote" ] && [ "$arg" = "get-url" ]; then strip=1; fi',
    "  prev=$arg",
    "done",
    'if [ "$strip" = 1 ]; then',
    "  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 \\",
    "    GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1 GIT_CONFIG_KEY_2 GIT_CONFIG_VALUE_2 \\",
    "    GIT_CONFIG_KEY_3 GIT_CONFIG_VALUE_3",
    "fi",
    `exec ${shQuote(realGit)} "$@"`,
  ]);
  worker.env.PATH = `${dir}${delimiter}${worker.env.PATH ?? ""}`;
  Object.assign(worker.env, {
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: `url.${worker.remote}.insteadOf`,
    GIT_CONFIG_VALUE_3: httpUrl,
  });
  return logPath;
}

function registerMergeRequest(worker: WorkerFixture, forge: FakeGitlabForge): void {
  const db = new Database(worker.dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    db.run(
      `INSERT INTO agent_prs (
         provider, instance_url, project_id, project_path, change_number, web_url,
         repo, pr_number, branch, state, created_at, updated_at
       ) VALUES ('gitlab', ?, '1', ?, 1, ?, ?, 1, ?, 'open', ?, ?)`,
      [forge.baseUrl, PROJECT_PATH, forge.mergeRequestUrl, PROJECT_PATH, FEATURE_BRANCH, now, now],
    );
  } finally {
    db.close();
  }
}

/**
 * Build the conflicting branch, forge, and harness chain. The caller starts
 * the worker or the one-shot command, and always closes the fixture.
 */
async function openConflictHarness(
  fallbackBehavior: "delegate" | "limit",
): Promise<ConflictHarness> {
  const gitBin = Bun.which("git");
  if (!gitBin) throw new Error("git is required for the conflict fixture");

  const worker = new WorkerFixture({
    automations: [
      {
        id: "keep-alive",
        enabled: false,
        prompt: "This disabled automation only keeps the workspace worker alive.",
        cron: "0 0 1 1 *",
      },
    ],
  });
  let forge: FakeGitlabForge | undefined;
  try {
    await worker.prepare();
    await seedConflict(worker, gitBin);
    await proveConflict(worker, gitBin);

    forge = new FakeGitlabForge({
      gitDir: worker.remote,
      gitBin,
      sourceBranch: FEATURE_BRANCH,
      targetBranch: worker.baseBranch,
    });
    const remoteUrl = `${forge.baseUrl}/${PROJECT_PATH}.git`;
    const stubs = configureFailover(worker, fallbackBehavior);
    worker.env.DEVINTERN_EXPERIMENTAL_GITLAB_CODE_HOST = "true";
    worker.env.GITLAB_CODE_HOST_URL = forge.baseUrl;
    worker.env.GITLAB_CODE_HOST_TOKEN = FAKE_GITLAB_TOKEN;
    worker.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(worker.root, "review-worktree");
    const gitLog = installGitRewrite(worker, gitBin, remoteUrl);
    patchWorkspace(worker, remoteUrl);

    const heads = await checkedCommand(
      ["git", "ls-remote", "--heads", remoteUrl],
      worker.root,
      worker.env,
    );
    if (
      !heads.includes(`refs/heads/${FEATURE_BRANCH}`) ||
      !heads.includes(`refs/heads/${worker.baseBranch}`)
    ) {
      throw new Error(`git insteadOf did not reach the bare remote:\n${heads}`);
    }
    const originProbe = join(worker.root, "origin-probe.git");
    await checkedCommand(
      ["git", "clone", "--bare", remoteUrl, originProbe],
      worker.root,
      worker.env,
    );
    const shownOrigin = await checkedCommand(
      ["git", "--git-dir", originProbe, "remote", "get-url", "origin"],
      worker.root,
      worker.env,
    );
    rmSync(originProbe, { recursive: true, force: true });
    if (shownOrigin !== remoteUrl) {
      throw new Error(`git remote get-url returned ${shownOrigin}, expected the forge URL`);
    }
    if (!forge) throw new Error("fake GitLab forge did not start");

    const headSha = revParse(gitBin, worker.remote, FEATURE_BRANCH);
    const baseSha = revParse(gitBin, worker.remote, worker.baseBranch);
    const mergeBaseSha = mergeBase(gitBin, worker.remote, FEATURE_BRANCH, worker.baseBranch);
    if (mergeBaseSha === baseSha) {
      throw new Error(
        "seeded merge base equals the target tip, so GitLab base_sha would match origin/<base>",
      );
    }

    return {
      worker,
      forge,
      realGit: gitBin,
      gitLog,
      stubs,
      headSha,
      baseSha,
      mergeBaseSha,
      gitBaseline: gitLines(gitLog).length,
    };
  } catch (error) {
    forge?.stop();
    await worker.dispose();
    throw error;
  }
}

async function closeConflictHarness(harness: ConflictHarness | undefined): Promise<void> {
  if (!harness) return;
  try {
    harness.forge.stop();
  } finally {
    await harness.worker.dispose();
  }
}

function assertIsolated(record: InvocationRecord, worker: WorkerFixture, label: string): void {
  expect(record.home, label).toBe(worker.env.HOME);
  expect(record.xdg, label).toBe(worker.env.XDG_CONFIG_HOME);
  expect(record.queue, label).toBe(worker.env.WEBHOOK_QUEUE_DB);
  expect(record.output, label).toBe(worker.env.DEVINTERN_OUTPUT_DIR);
  expect(record.workspace, label).toBe(worker.env.DEVINTERN_WORKSPACE_DIR);
  expect(record.gitlabToken, label).toBe("fixture");
  expect(record.secrets, label).toEqual([]);
}

function workerDiagnostics(harness: ConflictHarness, extra: string[] = []): string {
  const runs = harness.worker.runRecords().map((run) => run.status);
  return redact(
    [
      ...extra,
      `running=${harness.worker.running}`,
      `primary=${readInvocations(harness.stubs.primaryInvocations).length}`,
      `fallback=${readInvocations(harness.stubs.fallbackInvocations).length}`,
      `agent=${JSON.stringify(harness.worker.agentInvocations())}`,
      `pushes=${JSON.stringify(pushLines(harness.gitLog, harness.gitBaseline))}`,
      `mutations=${JSON.stringify(harness.forge.mutations())}`,
      `authFailures=${harness.forge.authFailures.length}`,
      `injected=${harness.worker.injectedRows().length}`,
      `runs=${JSON.stringify(runs)}`,
      `active=${harness.worker.activeHarness() ?? "unset"}`,
      harness.worker.tail(),
    ].join("\n"),
  );
}

cliTest(
  "worker conflict resolution fails over to the fallback harness and pushes the same branch",
  async () => {
    let harness: ConflictHarness | undefined;
    try {
      harness = await openConflictHarness("delegate");
      const fixture = harness;
      fixture.worker.start();
      await fixture.worker.waitForReady();
      registerMergeRequest(fixture.worker, fixture.forge);

      await fixture.worker.waitFor(
        "the fallback harness to clear the conflict on the PR branch",
        () => {
          const greeting = showFile(
            fixture.realGit,
            fixture.worker.remote,
            FEATURE_BRANCH,
            "src/greeting.ts",
          );
          return greeting === MERGED_GREETING ? greeting : undefined;
        },
        150_000,
      );

      // The poll snapshot copies diff_refs.base_sha, the merge base, not the target tip.
      const expectedSync = syncEventId(
        fixture.forge.baseUrl,
        fixture.mergeBaseSha,
        fixture.headSha,
      );
      await fixture.worker.waitFor("the conflict sync to be marked processed", () => {
        const rows = processedEvents(fixture.worker.dbPath);
        return rows.some(
          (row) =>
            row.source === "gitlab:registered-mr-feedback" && row.external_id === expectedSync,
        )
          ? rows
          : undefined;
      });

      const diagnostics = () => workerDiagnostics(fixture);
      const primary = readInvocations(fixture.stubs.primaryInvocations);
      const fallback = readInvocations(fixture.stubs.fallbackInvocations);
      expect(primary, diagnostics()).toHaveLength(1);
      expect(fallback, diagnostics()).toHaveLength(1);
      expect(primary[0]?.target, diagnostics()).toBe(fixture.stubs.primaryPath);
      expect(fallback[0]?.target, diagnostics()).toBe(fixture.stubs.fallbackPath);
      expect(primary[0]?.harness, diagnostics()).toBe("claude-code");
      expect(fallback[0]?.harness, diagnostics()).toBe("codex");
      expect(primary[0]?.chain, diagnostics()).toBe("claude-code,codex");
      expect(fallback[0]?.chain, diagnostics()).toBe("claude-code,codex");
      expect(primary[0]?.workerChild, diagnostics()).toBe("1");
      expect(fallback[0]?.workerChild, diagnostics()).toBe("1");
      expect(primary[0]?.model, diagnostics()).toBe(PRIMARY_MODEL);
      expect(fallback[0]?.model, diagnostics()).toBe(FALLBACK_MODEL);
      expect(primary[0]?.conflictPrompt, diagnostics()).toBe("1");
      expect(fallback[0]?.conflictPrompt, diagnostics()).toBe("1");
      assertIsolated(primary[0]!, fixture.worker, diagnostics());
      assertIsolated(fallback[0]!, fixture.worker, diagnostics());

      expect(fixture.worker.agentInvocations(), diagnostics()).toEqual([{ mode: "conflict" }]);
      expect(
        showFile(fixture.realGit, fixture.worker.remote, FEATURE_BRANCH, "src/greeting.ts"),
      ).toBe(MERGED_GREETING);
      expect(
        showFile(
          fixture.realGit,
          fixture.worker.remote,
          fixture.worker.baseBranch,
          "src/greeting.ts",
        ),
      ).toBe(BASE_GREETING);
      expect(revParse(fixture.realGit, fixture.worker.remote, fixture.worker.baseBranch)).toBe(
        fixture.baseSha,
      );
      expect(revParse(fixture.realGit, fixture.worker.remote, FEATURE_BRANCH)).not.toBe(
        fixture.headSha,
      );
      // `git merge origin/<base>` records the previous feature tip, then the base.
      expect(
        commitParents(fixture.realGit, fixture.worker.remote, FEATURE_BRANCH),
        diagnostics(),
      ).toEqual([fixture.headSha, fixture.baseSha]);

      const pushes = pushLines(fixture.gitLog, fixture.gitBaseline);
      expect(pushes, diagnostics()).toEqual([`push origin ${FEATURE_BRANCH}`]);
      expect(
        pushes.some((line) => /--force/.test(line) || /(^|\s)\+\S+/.test(line)),
        diagnostics(),
      ).toBe(false);

      const mutations = fixture.forge.mutations();
      expect(
        mutations.every((request) => /\/merge_requests\/1\/notes(?:\?|$)/.test(request.path)),
        diagnostics(),
      ).toBe(true);
      expect(
        mutations.some((request) => request.path.split("?")[0]?.endsWith("/merge")),
        diagnostics(),
      ).toBe(false);
      expect(fixture.forge.authFailures, diagnostics()).toEqual([]);

      // GitLab resolveMr does not call RunStore.createRun, so a run row is not
      // the outcome record. The processed sync id above is.
      expect(fixture.worker.injectedRows(), diagnostics()).toEqual([]);
      expect(fixture.worker.logs, diagnostics()).toContain("syncing to the actual tip");
      expect(fixture.worker.logs, diagnostics()).toContain("claude-code hit a usage limit");
      expect(fixture.worker.logs, diagnostics()).toContain("failing over to codex");
      expect(fixture.worker.rateLimits()["claude-code"] ?? 0, diagnostics()).toBeGreaterThan(
        Date.now(),
      );
      expect(fixture.worker.activeHarness(), diagnostics()).toBe("codex");
      expect(fixture.worker.running, diagnostics()).toBe(true);
    } finally {
      await closeConflictHarness(harness);
    }
  },
  180_000,
);

cliTest(
  "worker defers conflict resolution when every harness is usage-limited",
  async () => {
    let harness: ConflictHarness | undefined;
    try {
      harness = await openConflictHarness("limit");
      const fixture = harness;
      fixture.worker.start();
      await fixture.worker.waitForReady();
      registerMergeRequest(fixture.worker, fixture.forge);
      await fixture.worker.waitForOutput(
        /All harnesses in the chain are usage-limited/,
        90_000,
        "exhausted harness chain",
      );

      const limits = await fixture.worker.waitFor("both harness windows to be persisted", () => {
        const windows = fixture.worker.rateLimits();
        return (windows["claude-code"] ?? 0) > Date.now() && (windows.codex ?? 0) > Date.now()
          ? windows
          : undefined;
      });

      // The GitLab poller backs off for 30s after a deferred sync. A second
      // wave inside this window would be a tight retry, not that backoff.
      await Bun.sleep(2_500);
      const diagnostics = () => workerDiagnostics(fixture);
      expect(readInvocations(fixture.stubs.primaryInvocations), diagnostics()).toHaveLength(1);
      expect(readInvocations(fixture.stubs.fallbackInvocations), diagnostics()).toHaveLength(1);
      expect(fixture.worker.agentInvocations(), diagnostics()).toEqual([]);
      expect(
        showFile(fixture.realGit, fixture.worker.remote, FEATURE_BRANCH, "src/greeting.ts"),
      ).toBe(BRANCH_GREETING);
      expect(parentCount(fixture.realGit, fixture.worker.remote, FEATURE_BRANCH)).toBe(1);
      expect(revParse(fixture.realGit, fixture.worker.remote, FEATURE_BRANCH)).toBe(
        fixture.headSha,
      );
      expect(revParse(fixture.realGit, fixture.worker.remote, fixture.worker.baseBranch)).toBe(
        fixture.baseSha,
      );
      expect(pushLines(fixture.gitLog, fixture.gitBaseline), diagnostics()).toEqual([]);
      expect(fixture.forge.mutations(), diagnostics()).toEqual([]);
      expect(
        processedEvents(fixture.worker.dbPath).some((row) => row.external_id.startsWith("sync:")),
        diagnostics(),
      ).toBe(false);
      // A deferred GitLab conflict job also writes no run. The unprocessed
      // sync id above is the deferral record.
      expect(fixture.worker.injectedRows(), diagnostics()).toEqual([]);
      expect(limits["claude-code"]).toBeGreaterThan(Date.now());
      expect(limits.codex).toBeGreaterThan(Date.now());
      expect(fixture.worker.activeHarness(), diagnostics()).toBe("codex");
      expect(fixture.worker.running, diagnostics()).toBe(true);
      expect(fixture.worker.logs, diagnostics()).toContain(
        "All harnesses in the chain are usage-limited",
      );
    } finally {
      await closeConflictHarness(harness);
    }
  },
  120_000,
);

cliTest(
  "standalone resolve-conflicts keeps the first harness and does not fail over",
  async () => {
    let harness: ConflictHarness | undefined;
    try {
      harness = await openConflictHarness("delegate");
      const fixture = harness;
      const checkout = join(fixture.worker.root, "oneshot");
      await checkedCommand(
        [fixture.realGit, "clone", fixture.worker.remote, checkout],
        fixture.worker.root,
        fixture.worker.env,
      );
      const remoteUrl = `${fixture.forge.baseUrl}/${PROJECT_PATH}.git`;
      await checkedCommand(
        [fixture.realGit, "-C", checkout, "remote", "set-url", "origin", remoteUrl],
        checkout,
        fixture.worker.env,
      );
      await checkedCommand(
        [fixture.realGit, "-C", checkout, "checkout", FEATURE_BRANCH],
        checkout,
        fixture.worker.env,
      );
      // Setup git used the real binary. Only the command under test is wrapped.
      const baseline = gitLines(fixture.gitLog).length;
      delete fixture.worker.env.DEVINTERN_WORKER_CHILD;
      delete fixture.worker.env.DEVINTERN_WORKER_SUBPROCESS;

      const result = await command(
        [process.execPath, cliPath, "resolve-conflicts", fixture.forge.mergeRequestUrl],
        checkout,
        fixture.worker.env,
        90_000,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const diagnostics = () =>
        [
          `exit=${result.exitCode}`,
          `primary=${readInvocations(fixture.stubs.primaryInvocations).length}`,
          `fallback=${readInvocations(fixture.stubs.fallbackInvocations).length}`,
          `pushes=${JSON.stringify(pushLines(fixture.gitLog, baseline))}`,
          bounded(output),
        ].join("\n");

      // Documented one-shot contract: the first AGENT_HARNESS entry runs, and
      // the rest of the chain is not a failover list for this command.
      const primary = readInvocations(fixture.stubs.primaryInvocations);
      const fallback = readInvocations(fixture.stubs.fallbackInvocations);
      expect(primary, diagnostics()).toHaveLength(1);
      expect(fallback, diagnostics()).toHaveLength(0);
      expect(primary[0]?.harness, diagnostics()).toBe("claude-code,codex");
      expect(primary[0]?.workerChild, diagnostics()).toBe("");
      expect(primary[0]?.chain, diagnostics()).toBe("");
      expect(primary[0]?.model, diagnostics()).toBe(PRIMARY_MODEL);
      expect(primary[0]?.target, diagnostics()).toBe(fixture.stubs.primaryPath);
      expect(primary[0]?.conflictPrompt, diagnostics()).toBe("1");
      assertIsolated(primary[0]!, fixture.worker, diagnostics());
      expect(result.exitCode, diagnostics()).toBe(1);
      expect(output, diagnostics()).toContain("Agent usage limit reached");
      expect(output, diagnostics()).toContain("Claude usage limit reached");
      expect(output, diagnostics()).not.toContain("failing over to codex");
      expect(revParse(fixture.realGit, fixture.worker.remote, FEATURE_BRANCH)).toBe(
        fixture.headSha,
      );
      expect(pushLines(fixture.gitLog, baseline), diagnostics()).toEqual([]);
      expect(fixture.forge.mutations(), diagnostics()).toEqual([]);
      expect(fixture.worker.agentInvocations(), diagnostics()).toEqual([]);
    } finally {
      await closeConflictHarness(harness);
    }
  },
  120_000,
);
