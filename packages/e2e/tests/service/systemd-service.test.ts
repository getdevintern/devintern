/**
 * Native systemd user service, end to end on a blank box (opt-in:
 * `test:e2e:service`; needs Docker).
 *
 * A Debian container runs systemd as PID 1 and has the packed CLI installed
 * globally for a non-root user. Inside it the test sets up a markdown
 * workspace with `worker init --non-interactive`, then installs the service
 * with `devintern worker service install` from a shell with no TTY, the way
 * a coding agent or provisioning script would:
 *
 * - Without a license the install is refused (sign-in is the step left);
 *   with `--force` the worker's license failure is reported honestly, lands
 *   in the worker log, and systemd stops retrying (exit 78).
 * - With the e2e license bypass (the only place it is set) the install
 *   reports a running worker, which processes a task with settings it can
 *   only have read from `~/.devintern/.env`, serves the dashboard, and is
 *   restarted by systemd after a crash.
 * - `service stop` ends in a clean exit (inactive, not failed) and
 *   `worker status` says stopped; `start`, `restart`, the wizard's in-place
 *   update, the lingering warning, and `uninstall` follow.
 *
 * The host's service manager, home directory and network are never touched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SystemdContainer, buildServiceImage } from "../../helpers/systemd-container";

const enabled = process.env.DEVINTERN_E2E_SERVICE === "1";

const UNIT = "/home/tester/.config/systemd/user/devintern-worker.service";
const WORKSPACE = "/home/tester/.devintern";
const TASK_KEY = "svc-greeting";

/**
 * Wizard driver. Optional integrations are declined; the service offer gets
 * `y`. Anything else takes its default.
 */
const WIZARD_EXPECT = String.raw`set timeout 180
log_user 1
cd /home/tester/app
spawn -noecho devintern worker init
expect {
  -re {Ready-tasks query[^\n]*: } { send -- "status=todo\r"; exp_continue }
  -re {background service[^\n]*\]: } { send -- "y\r"; exp_continue }
  -re {already installed[^\n]*\]: } { send -- "y\r"; exp_continue }
  -re {Sentry[^\n]*\]: } { send -- "n\r"; exp_continue }
  -re {Worker Pilot[^\n]*\]: } { send -- "n\r"; exp_continue }
  -re {React in seconds[^\n]*\]: } { send -- "n\r"; exp_continue }
  -re {\]: } { send -- "\r"; exp_continue }
  timeout { puts "\n<<HARNESS: TIMEOUT>>"; exit 98 }
  eof {}
}
set status [wait]
exit [lindex $status 3]
`;

/**
 * A git repo with a local bare origin, a markdown task, and a workspace.
 * No license bypass yet: the first install must see an unlicensed worker.
 */
const SETUP = String.raw`set -eu
# No global git config at all, like a fresh box: the seed commit names its
# author inline, and the worker must commit without any configured identity.
test ! -e ~/.gitconfig
cp -r ~/fixture ~/seed-src
git -C ~/seed-src init -q -b main
git -C ~/seed-src add .
git -C ~/seed-src -c user.name="Fixture Seed" -c user.email=seed@example.invalid \
  commit -qm "Seed service E2E fixture"
git clone -q --bare ~/seed-src ~/remote.git
git clone -q ~/remote.git ~/app
mkdir -p ~/tasks
printf -- '---\nstatus: todo\n---\n# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n' > ~/tasks/${TASK_KEY}.md
cd ~/app
# Exits non-zero: no agent CLI and no license yet. The agent is set below.
MARKDOWN_TASKS_DIR=$HOME/tasks devintern worker init --non-interactive --tracker markdown \
  --task-query status=todo --repo-from-cwd </dev/null || true
test -f ${WORKSPACE}/workspace.toml
# --create-pr pushes the branch; the PR step itself fails on a bare remote.
# Only the service can read these, so a processed task proves the unit loaded
# the workspace .env. TASK_TRACKER: the wizard does not read [defaults].tracker
# from workspace.toml and would otherwise run tracker setup again.
cat >> ${WORKSPACE}/.env <<EOF
TASK_TRACKER=markdown
AGENT_CLI_PATH=/home/tester/fake-agent.ts
AGENT_SANDBOX=none
DEVINTERN_NO_UPDATE=1
DEVINTERN_TELEMETRY_DISABLED=1
SENTRY_DISABLED=1
EOF
sed -i 's|^worker_task_args = .*|worker_task_args = "--create-pr --skip-clarity-check --skip-comments"|; s|^poll_interval = .*|poll_interval = 2|' ${WORKSPACE}/workspace.toml
cat > ~/wizard.exp <<'EXP'
${WIZARD_EXPECT}EXP
# A loginctl that reports lingering off and cannot enable it (no polkit), for
# the lingering-warning check only.
mkdir -p ~/stub-bin
cat > ~/stub-bin/loginctl <<'EOF'
#!/bin/sh
if [ "$1" = show-user ]; then echo no; exit 0; fi
echo "Could not enable linger: Access denied" >&2
exit 1
EOF
chmod +x ~/stub-bin/loginctl
`;

interface ServiceDoc {
  schema: string;
  action: string;
  result: string;
  error?: string;
  updated?: boolean;
  start?: {
    state: string;
    pid?: number;
    reason?: string;
    permanent?: boolean;
    logLines?: string[];
  };
  warnings: string[];
  service?: { state: string; installed: boolean; worker: { status: string } };
  nextSteps: { message: string; command: string }[];
}

describe.skipIf(!enabled)("systemd user service built CLI E2E", () => {
  const container = new SystemdContainer();

  /** Run `devintern worker service ...` with no TTY and parse its JSON document. */
  async function service(
    args: string,
    prefix = "",
  ): Promise<{ exitCode: number; doc: ServiceDoc; stderr: string }> {
    const result = await container.user(
      `${prefix}devintern worker service ${args} --json </dev/null`,
      180_000,
    );
    let doc: ServiceDoc;
    try {
      doc = JSON.parse(result.stdout) as ServiceDoc;
    } catch {
      throw new Error(
        `worker service ${args} printed no JSON (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}\n${await container.journal()}`,
      );
    }
    return { exitCode: result.exitCode, doc, stderr: result.stderr };
  }

  beforeAll(async () => {
    const tarball = process.env.E2E_SERVICE_CLI_TARBALL;
    if (!tarball) {
      throw new Error(
        "Run through `bun run --filter @devintern/e2e test:e2e:service`, which packs the CLI",
      );
    }
    await buildServiceImage(tarball);
    await container.start();
    await container.checkedUser(SETUP);
  }, 900_000);

  afterAll(async () => {
    await container.dispose();
  });

  test("without a license, install is refused before anything is installed", async () => {
    const { exitCode, doc } = await service("install");
    // Signing in is the only step left: exit 2, like `worker doctor`.
    expect(exitCode, JSON.stringify(doc, null, 2)).toBe(2);
    expect(doc.result).toBe("action_required");
    expect(doc.nextSteps.at(-1)?.command).toBe("devintern worker service install");
    expect((await container.user(`test -e ${UNIT}`)).exitCode).not.toBe(0);
  }, 240_000);

  test("--force installs, and the license failure is reported, logged, and not retried", async () => {
    const { exitCode, doc } = await service("install --force");
    expect(exitCode, JSON.stringify(doc, null, 2)).toBe(1);
    expect(doc.result).toBe("failed");
    expect(doc.start?.state).toBe("failed");
    expect(doc.start?.permanent).toBe(true);
    expect(doc.start?.reason).toContain("License check failed");
    expect(doc.nextSteps.map((step) => step.command)).toContain("devintern worker service restart");
    // systemd gave up at once (RestartPreventExitStatus=78): no 30 s loop.
    expect(await container.unitProperty("ActiveState")).toBe("failed");
    expect(await container.unitProperty("ExecMainStatus")).toBe("78");
    expect(await container.unitProperty("NRestarts")).toBe("0");
    // The reason is in the worker's own log, not only in the journal.
    expect(await container.checkedUser(`cat ${WORKSPACE}/worker.stderr.log`)).toContain(
      "License check failed",
    );
    expect(await container.checkedUser("devintern worker status")).toContain(
      "Worker:     stopped (failed to start at",
    );
    const status = await container.user("devintern worker service status");
    expect(status.exitCode).toBe(0);
    expect(status.stdout + status.stderr).toContain("Service:    failed");
    expect(status.stdout + status.stderr).toContain("devintern worker service restart");
  }, 240_000);

  test("with a license, install from a shell without a TTY reports a running worker", async () => {
    // The e2e license bypass, used only for the success path.
    await container.checkedUser(`echo DEVINTERN_SKIP_LICENSE_CHECK=1 >> ${WORKSPACE}/.env`);
    const { exitCode, doc } = await service("install");
    expect(exitCode, JSON.stringify(doc, null, 2)).toBe(0);
    expect(doc.result).toBe("running");
    expect(doc.updated).toBe(true);
    expect(doc.start?.pid).toBe(Number(await container.unitProperty("MainPID")));
    // Lingering is already on (the suite enabled it as root), so no warning.
    expect(doc.warnings).toEqual([]);
    expect(await container.unitProperty("ActiveState")).toBe("active");
  }, 240_000);

  test("the unit is enabled and points at the global install", async () => {
    const unit = await container.checkedUser(`cat ${UNIT}`);
    expect(unit).toContain("# Managed by devintern worker init");
    expect(unit).toContain(`WorkingDirectory=${WORKSPACE}\n`);
    // The runtime and the bundle are absolute, so systemd's minimal PATH
    // cannot break the bun shebang, and the recorded PATH has bun's dir.
    expect(unit).toMatch(
      /^ExecStart=\/usr\/local\/bin\/bun "?\/home\/tester\/\.bun\/install\/global\/node_modules\/@getdevintern\/code\/dist\/index\.js"? worker$/m,
    );
    expect(unit).toMatch(/^Environment="PATH=[^"]*\/usr\/local\/bin[^"]*"$/m);
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("RestartPreventExitStatus=78\n");
    expect(
      (await container.user("systemctl --user is-enabled devintern-worker")).stdout.trim(),
    ).toBe("enabled");
  });

  test("the service loads the workspace .env and processes a task", async () => {
    // The task branch on the bare origin proves MARKDOWN_TASKS_DIR and
    // AGENT_CLI_PATH reached the daemon and its task subprocess.
    await container.waitFor(
      "the service to push the task branch",
      async () =>
        (
          await container.user(
            `git --git-dir ~/remote.git rev-parse -q --verify feature/${TASK_KEY}`,
          )
        ).exitCode === 0,
      120_000,
    );
    expect(
      await container.checkedUser(
        `git --git-dir ~/remote.git show feature/${TASK_KEY}:src/greeting.ts`,
      ),
    ).toBe('export const greeting = "Hello, world!";\n');
    // The host has no git identity and no token: the task commit carries the
    // DevIntern fallback, never the seed commit's author, and no git config
    // was written to get there.
    expect(
      (
        await container.checkedUser(
          `git --git-dir ~/remote.git log -1 --format='%an <%ae>|%cn <%ce>' feature/${TASK_KEY}`,
        )
      ).trim(),
    ).toBe(
      "DevIntern <devintern@users.noreply.github.com>|DevIntern <devintern@users.noreply.github.com>",
    );
    expect((await container.user("test -e ~/.gitconfig")).exitCode).not.toBe(0);
    const journal = await container.journal();
    expect(journal).toContain("License check skipped (DEVINTERN_SKIP_LICENSE_CHECK=1)");
    // The daemon tees its own output into the dashboard capture files.
    expect(await container.checkedUser(`cat ${WORKSPACE}/worker.stdout.log`)).toContain(
      "Starting devintern worker",
    );
  });

  test("worker status and the dashboard see the service daemon", async () => {
    const pid = await container.unitProperty("MainPID");
    expect(Number(pid)).toBeGreaterThan(0);
    expect(await container.checkedUser("devintern worker status")).toContain(
      `running (pid ${pid})`,
    );
    const api = await container.checkedUser(
      "curl -sf --noproxy '*' http://127.0.0.1:4400/api/worker",
    );
    expect(JSON.parse(api).worker.status).toBe("running");
  });

  test("systemd restarts the worker after a crash", async () => {
    const before = await container.unitProperty("MainPID");
    const restartsBefore = Number(await container.unitProperty("NRestarts"));
    await container.checkedUser(`kill -KILL ${before}`);
    // RestartSec=30 in the generated unit.
    await container.waitFor(
      "systemd to restart the crashed worker",
      async () =>
        (await container.unitProperty("ActiveState")) === "active" &&
        !["0", before].includes(await container.unitProperty("MainPID")),
      90_000,
    );
    expect(Number(await container.unitProperty("NRestarts"))).toBe(restartsBefore + 1);
  }, 120_000);

  test("service stop is a clean exit: inactive, not failed, and status says stopped", async () => {
    await container.waitFor(
      "the restarted worker to finish starting",
      async () => (await service("status")).doc.result === "running",
      90_000,
    );
    const { exitCode, doc } = await service("stop");
    expect(exitCode, JSON.stringify(doc, null, 2)).toBe(0);
    expect(doc.result).toBe("stopped");
    expect(await container.unitProperty("ActiveState")).toBe("inactive");
    expect(await container.unitProperty("Result")).toBe("success");
    expect(await container.unitProperty("ExecMainStatus")).toBe("0");
    // The worker's own graceful shutdown ran to the end.
    expect(await container.journal()).toContain("👋 Worker stopped");
    expect(await container.checkedUser("devintern worker status")).toContain(
      "Worker:     stopped (clean stop at",
    );
    expect(doc.service?.worker.status).toBe("stopped");
    // Stopping again is a no-op.
    expect((await service("stop")).exitCode).toBe(0);
  }, 240_000);

  test("service start and restart wait for a running worker", async () => {
    const started = await service("start");
    expect(started.exitCode, JSON.stringify(started.doc, null, 2)).toBe(0);
    expect(started.doc.result).toBe("running");
    const firstPid = started.doc.start?.pid;
    expect(firstPid).toBeGreaterThan(0);

    const restarted = await service("restart");
    expect(restarted.exitCode, JSON.stringify(restarted.doc, null, 2)).toBe(0);
    expect(restarted.doc.result).toBe("running");
    expect(restarted.doc.start?.pid).toBeGreaterThan(0);
    expect(restarted.doc.start?.pid).not.toBe(firstPid);
    expect(await container.unitProperty("ActiveState")).toBe("active");
  }, 300_000);

  test("re-running the wizard updates the managed unit in place", async () => {
    const again = await container.user("expect ~/wizard.exp", 300_000);
    const output = again.stdout + again.stderr;
    expect(again.exitCode, output).toBe(0);
    expect(output).toContain("devintern-worker service updated and restarted");
    expect(output).toContain("The worker is running");
    expect(await container.unitProperty("ActiveState")).toBe("active");
    const units = await container.checkedUser("ls ~/.config/systemd/user");
    expect(units.split("\n").filter((name) => name.endsWith(".service"))).toEqual([
      "devintern-worker.service",
    ]);
  }, 320_000);

  test("when lingering cannot be enabled, install names the root command", async () => {
    const { exitCode, doc } = await service("install", "PATH=$HOME/stub-bin:$PATH ");
    expect(exitCode, JSON.stringify(doc, null, 2)).toBe(0);
    expect(doc.result).toBe("running");
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toContain("could not enable lingering for tester");
    expect(doc.warnings[0]).toContain("stops when you log out");
    expect(doc.warnings[0]).toContain("sudo loginctl enable-linger tester");
  }, 240_000);

  test("uninstall stops the worker cleanly and removes the unit", async () => {
    const { exitCode, doc } = await service("uninstall");
    expect(exitCode, JSON.stringify(doc, null, 2)).toBe(0);
    expect(doc.result).toBe("uninstalled");
    expect((await container.user(`test -e ${UNIT}`)).exitCode).not.toBe(0);
    expect((await container.user("systemctl --user cat devintern-worker")).exitCode).not.toBe(0);
    expect(await container.checkedUser("devintern worker status")).toContain(
      "Worker:     stopped (clean stop at",
    );
    const status = await service("status");
    expect(status.doc.result).toBe("not_installed");
    expect((await service("uninstall")).doc.result).toBe("not_installed");
  }, 240_000);
});
