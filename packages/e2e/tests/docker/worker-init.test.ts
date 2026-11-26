/**
 * "Blank machine" smoke for `devintern worker init --non-interactive`.
 *
 * Opt-in: `bun run --filter @devintern/e2e test:docker` packs the built CLI,
 * installs it globally in docker/worker-init/Dockerfile (clean Debian Bun
 * image, git only, non-root user), and runs this file with
 * DEVINTERN_E2E_DOCKER_IMAGE set. A direct `bun test` skips it.
 *
 * Each test gets a fresh container with `--network none`, so the CLI sees a
 * first-time install: the default `~/.devintern` workspace, no agent CLI, no
 * session, no license, no test-only skip flags. Commands run through
 * `docker exec` without `-i`/`-t`: no TTY and stdin closed, as in a
 * provisioning script. The checkout's `origin` is a bare repository inside the
 * container, so repository access is checked without the network.
 */
import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../../helpers/process";
import { outputLines, parseReport } from "../../helpers/worker-init";

const image = process.env.DEVINTERN_E2E_DOCKER_IMAGE;

const HOME = "/home/tester";
const WS = `${HOME}/.devintern`;
const TASKS = `${HOME}/tasks`;
const APP = `${HOME}/app`;
const REMOTE = `${HOME}/remotes/app.git`;

/** Seed a bare remote, a checkout of it, and a Markdown task folder. */
const SETUP = `
set -e
git init -q --bare -b main ${REMOTE}
git init -q -b main ${APP}
cd ${APP}
echo '# app' > README.md
git add README.md
git -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m init
git remote add origin ${REMOTE}
git push -q -u origin main
mkdir -p ${TASKS}
printf -- '---\\nstatus: todo\\n---\\n# Sample\\n\\nDo a thing.\\n' > ${TASKS}/T-1.md
`;

/** A stub agent CLI, so only the harness check differs from a real setup. */
const STUB_AGENT = `
mkdir -p ${HOME}/bin
printf '#!/bin/sh\\necho stub agent 0.0.0\\n' > ${HOME}/bin/claude
chmod +x ${HOME}/bin/claude
`;

/** The entitlement needs a signed-in session, which a blank machine lacks; this skips it. */
const SKIP_LICENSE = "DEVINTERN_SKIP_LICENSE_CHECK=1";

const INIT_MARKDOWN = `MARKDOWN_TASKS_DIR=${TASKS} devintern worker init --non-interactive --tracker markdown --task-query status=todo --repo-from-cwd`;

async function exec(args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

class BlankMachine {
  readonly name = `devintern-e2e-worker-init-${crypto.randomUUID().slice(0, 8)}`;

  async start(): Promise<void> {
    const started = await exec([
      "docker",
      "run",
      "--detach",
      "--rm",
      "--network",
      "none",
      "--name",
      this.name,
      image!,
      "sleep",
      "infinity",
    ]);
    if (started.exitCode !== 0) throw new Error(`docker run failed: ${started.stderr}`);
  }

  /** Run a bash script as the non-root user: no TTY, stdin closed. */
  sh(script: string, cwd = APP): Promise<CommandResult> {
    return exec([
      "docker",
      "exec",
      "--workdir",
      HOME,
      "--env",
      `PATH=${HOME}/bin:${HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      this.name,
      "bash",
      "-c",
      `cd ${cwd} 2>/dev/null || true\n${script}`,
    ]);
  }

  async checked(script: string): Promise<string> {
    const result = await this.sh(script, HOME);
    if (result.exitCode !== 0) {
      throw new Error(`container script failed:\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout;
  }

  /** `mode name` for each file directly inside ~/.devintern. */
  async workspaceFiles(): Promise<string[]> {
    const out = await this.checked(
      `[ -d ${WS} ] && find ${WS} -maxdepth 1 -type f -printf '%m %f\\n' | sort || true`,
    );
    return outputLines(out);
  }

  async stop(): Promise<void> {
    await exec(["docker", "rm", "--force", this.name]);
  }
}

async function onBlankMachine(
  run: (machine: BlankMachine) => Promise<void>,
  options: { agent?: boolean } = {},
): Promise<void> {
  const machine = new BlankMachine();
  await machine.start();
  try {
    await machine.checked(SETUP + (options.agent ? STUB_AGENT : ""));
    await run(machine);
  } finally {
    await machine.stop();
  }
}

/** One `❌` line on stderr, empty stdout, exit 1, nothing in ~/.devintern. */
async function expectInputError(
  machine: BlankMachine,
  result: CommandResult,
  message: string,
): Promise<void> {
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.stdout).toBe("");
  const errors = outputLines(result.stderr).filter((line) => line.startsWith("❌"));
  expect(errors).toEqual([expect.stringContaining(message)]);
  expect(result.stderr).not.toMatch(/AbortError|^\s+at\s/m);
  expect(await machine.workspaceFiles()).toEqual([]);
}

describe.skipIf(!image)("worker init on a blank machine (Docker)", () => {
  test("happy path with a stub agent: one JSON document, 0600 .env, doctor agrees", async () => {
    await onBlankMachine(
      async (machine) => {
        // No license or session on a blank machine: init saves the setup and
        // reports signing in as the one step left (action_required, exit 2).
        const result = await machine.sh(`${INIT_MARKDOWN} --json`);
        expect(result.exitCode, result.stdout + result.stderr).toBe(2);
        const report = parseReport(result.stdout);
        expect(report).toMatchObject({
          schema: "devintern.worker-init",
          version: 1,
          result: "action_required",
          workspaceDir: WS,
          tracker: "markdown",
          taskQuery: "status=todo",
          repo: { name: "app", remote: REMOTE, added: true },
        });
        const status = Object.fromEntries(report.checks.map((check) => [check.name, check.status]));
        expect(status).toMatchObject({ query: "pass", repo: "pass", harness: "pass" });
        expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
        expect(report.checks.filter((check) => check.status === "action")).toEqual([
          expect.objectContaining({
            name: "entitlement",
            message:
              "Not started: sign in to begin your 14-day free Worker Pilot, no card required",
          }),
        ]);
        expect(report.nextSteps[0]).toMatchObject({
          id: "sign-in",
          command: "devintern worker login github --no-wait --json",
        });

        expect(await machine.workspaceFiles()).toEqual(
          expect.arrayContaining(["600 .env", expect.stringMatching(/^6\d\d workspace\.toml$/)]),
        );
        const toml = await machine.checked(`cat ${WS}/workspace.toml`);
        const config = Bun.TOML.parse(toml) as {
          defaults: { tracker: string; task_query: string };
          repos: Array<{ name: string; remote: string }>;
        };
        expect(config.defaults).toMatchObject({ tracker: "markdown", task_query: "status=todo" });
        expect(config.repos).toEqual([expect.objectContaining({ name: "app", remote: REMOTE })]);

        // Doctor reads the same files and agrees: sign-in is the one step left
        // (exit 2), and it passes once the license check is skipped.
        const doctor = await machine.sh("devintern worker doctor");
        expect(doctor.exitCode, doctor.stdout).toBe(2);
        expect(doctor.stdout).toContain(
          "👉 Automation entitlement — Not started: sign in to begin your 14-day free Worker Pilot, no card required",
        );
        expect(doctor.stdout).not.toContain("❌");
        for (const line of [
          "✅ Tracker credentials — markdown ([defaults])",
          "✅ Task query — markdown ([defaults]): 1 task matches",
          `✅ Repository access — [[repos]] "app" (${REMOTE}): remote reachable`,
          "✅ Agent harness — claude-code",
        ]) {
          expect(doctor.stdout).toContain(line);
        }
        const skipped = await machine.sh(`${SKIP_LICENSE} devintern worker doctor`);
        expect(skipped.exitCode, skipped.stdout).toBe(0);

        // The same flags again: a no-op (only sign-in is still left, so exit 2).
        const same = await machine.sh(INIT_MARKDOWN);
        expect(same.exitCode, same.stderr).toBe(2);
        expect(await machine.checked(`cat ${WS}/workspace.toml`)).toBe(toml);
        // Another query without --yes: refused, unchanged. With --yes: only the query.
        const refused = await machine.sh(INIT_MARKDOWN.replace("status=todo", "status=ready"));
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr).toContain(
          "already exists with other settings; nothing was changed. Pass --yes",
        );
        expect(await machine.checked(`cat ${WS}/workspace.toml`)).toBe(toml);
        const updated = await machine.sh(
          `${SKIP_LICENSE} ${INIT_MARKDOWN.replace("status=todo", "status=ready")} --yes --json`,
        );
        expect(updated.exitCode, updated.stdout).toBe(0);
        expect(await machine.checked(`cat ${WS}/workspace.toml`)).toBe(
          toml.replace('task_query = "status=todo"', 'task_query = "status=ready"'),
        );
      },
      { agent: true },
    );
  });

  test("a blank machine without an agent CLI fails the harness check", async () => {
    await onBlankMachine(async (machine) => {
      const result = await machine.sh(`${SKIP_LICENSE} ${INIT_MARKDOWN} --json`);
      expect(result.exitCode).toBe(1);
      const report = parseReport(result.stdout);
      expect(report.error).toBeUndefined();
      expect(report.checks.filter((check) => check.status === "fail").map((c) => c.name)).toEqual([
        "harness",
      ]);
    });
  });

  test("0 matching tasks is a warning", async () => {
    await onBlankMachine(
      async (machine) => {
        await machine.checked(`rm ${TASKS}/T-1.md`);
        const result = await machine.sh(`${SKIP_LICENSE} ${INIT_MARKDOWN} --json`);
        expect(result.exitCode, result.stdout).toBe(0);
        const query = parseReport(result.stdout).checks.find((check) => check.name === "query");
        expect(query).toMatchObject({ status: "warn" });
      },
      { agent: true },
    );
  });

  test("input errors write nothing and exit 1 with one line", async () => {
    await onBlankMachine(async (machine) => {
      await expectInputError(
        machine,
        await machine.sh("devintern worker init --non-interactive --tracker jira"),
        "missing: --task-query, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.",
      );
      const json = await machine.sh("devintern worker init --non-interactive --json");
      expect(json.exitCode).toBe(1);
      expect(parseReport(json.stdout).error).toStartWith("missing: --tracker, --task-query.");
      await expectInputError(
        machine,
        await machine.sh(
          "devintern worker init --non-interactive --tracker jira --task-query x --jira-token e2e-flag-value",
        ),
        "Unknown option: --jira-token. Secrets are never accepted as flags",
      );
      await expectInputError(
        machine,
        await machine.sh(
          "devintern worker init --non-interactive --tracker youtrack --task-query x",
        ),
        'Unsupported --tracker "youtrack".',
      );
      await machine.checked(
        `printf 'JIRA_BASE_URL=https://jira.invalid\\nJIRA_EMAIL=e2e@example.invalid\\nJIRA_API_TOKEN=e2e-loose-file-token\\n' > ${HOME}/creds.env && chmod 644 ${HOME}/creds.env`,
      );
      const loose = await machine.sh(
        `devintern worker init --non-interactive --tracker jira --task-query 'project = DEV' --env-file ${HOME}/creds.env`,
      );
      await expectInputError(machine, loose, "mode 0644 lets group or others read it");
      expect(loose.stderr).not.toContain("e2e-loose-file-token");
      await machine.checked(
        `mkdir -p ${HOME}/plain ${HOME}/no-origin && git init -q ${HOME}/no-origin`,
      );
      await expectInputError(
        machine,
        await machine.sh(INIT_MARKDOWN, `${HOME}/plain`),
        `--repo-from-cwd: ${HOME}/plain is not inside a git repository.`,
      );
      await expectInputError(
        machine,
        await machine.sh(INIT_MARKDOWN, `${HOME}/no-origin`),
        `--repo-from-cwd: ${HOME}/no-origin has no origin remote.`,
      );
      await expectInputError(
        machine,
        await machine.sh("devintern worker init --yes --json"),
        "--yes needs --non-interactive.",
      );
    });
  });

  test("plain worker init without a TTY points to --non-interactive", async () => {
    await onBlankMachine(async (machine) => {
      const result = await machine.sh("devintern worker init");
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "❌ 'devintern worker init' needs a terminal for its prompts.",
      );
      expect(result.stdout + result.stderr).toContain("--non-interactive");
      expect(await machine.workspaceFiles()).toEqual([]);
    });
  });

  test("concurrent runs: exactly one writes and one repo is registered", async () => {
    await onBlankMachine(
      async (machine) => {
        const result = await machine.sh(`
          for i in 1 2 3; do ${INIT_MARKDOWN} --json > /tmp/p$i.json 2>/dev/null & done
          wait
          for i in 1 2 3; do cat /tmp/p$i.json; echo '@@END@@'; done`);
        const reports = result.stdout
          .split("@@END@@")
          .map((part) => part.trim())
          .filter((part) => part !== "")
          .map(parseReport);
        expect(reports).toHaveLength(3);
        expect(reports.filter((report) => report.filesWritten.length > 0)).toHaveLength(1);
        expect(reports.filter((report) => report.error !== undefined)).toHaveLength(2);
        const toml = await machine.checked(`cat ${WS}/workspace.toml`);
        expect(toml.match(/^\[\[repos\]\]$/gm)).toHaveLength(1);
      },
      { agent: true },
    );
  });

  test("--env-file secrets never reach stdout or stderr", async () => {
    await onBlankMachine(
      async (machine) => {
        const token = `ghp_e2eDocker${crypto.randomUUID().replaceAll("-", "")}`;
        await machine.checked(
          `umask 077 && printf 'GITHUB_TOKEN=${token}\\nMARKDOWN_TASKS_DIR=${TASKS}\\n' > ${HOME}/creds.env`,
        );
        const base = `devintern worker init --non-interactive --tracker markdown --task-query status=todo --repo-from-cwd --env-file ${HOME}/creds.env`;
        for (const script of [`${base} --json`, `${base} --yes`, "devintern worker doctor"]) {
          const result = await machine.sh(script);
          expect(result.stdout).not.toContain(token);
          expect(result.stderr).not.toContain(token);
        }
        expect(await machine.checked(`grep -c '^GITHUB_TOKEN=' ${WS}/.env`)).toBe("1\n");
        expect(await machine.workspaceFiles()).toContain("600 .env");
      },
      { agent: true },
    );
  });
});
