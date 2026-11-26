/**
 * Native systemd user service, end to end on a blank box (opt-in:
 * `test:e2e:service`; needs Docker).
 *
 * A Debian container runs systemd as PID 1 and has the packed CLI installed
 * globally for a non-root user. Inside it the test sets up a markdown
 * workspace with `worker init --non-interactive`, then drives the
 * interactive `worker init` wizard through a PTY (`expect`) and accepts its
 * background-service step, which is the only way the product installs the
 * service. Everything is checked from the container's own point of view:
 * the generated unit, the daemon processing a task with settings it can only
 * have read from `~/.devintern/.env`, the dashboard on 127.0.0.1:4400,
 * restart after a crash, and an in-place update when the wizard runs again.
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
  -re {Ready-tasks query: } { send -- "status=todo\r"; exp_continue }
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

/** A git repo with a local bare origin, a markdown task, and a workspace. */
const SETUP = String.raw`set -eu
git config --global user.name "DevIntern E2E"
git config --global user.email e2e@example.invalid
git config --global init.defaultBranch main
cp -r ~/fixture ~/seed-src
git -C ~/seed-src init -q
git -C ~/seed-src add .
git -C ~/seed-src commit -qm "Seed service E2E fixture"
git clone -q --bare ~/seed-src ~/remote.git
git clone -q ~/remote.git ~/app
mkdir -p ~/tasks
printf -- '---\nstatus: todo\n---\n# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n' > ~/tasks/${TASK_KEY}.md
cd ~/app
# Exits 1: no agent CLI and no license yet. Both are set below.
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
DEVINTERN_SKIP_LICENSE_CHECK=1
DEVINTERN_NO_UPDATE=1
DEVINTERN_TELEMETRY_DISABLED=1
SENTRY_DISABLED=1
EOF
sed -i 's|^worker_task_args = .*|worker_task_args = "--create-pr --skip-clarity-check --skip-comments"|; s|^poll_interval = .*|poll_interval = 2|' ${WORKSPACE}/workspace.toml
cat > ~/wizard.exp <<'EXP'
${WIZARD_EXPECT}EXP
`;

describe.skipIf(!enabled)("systemd user service built CLI E2E", () => {
  const container = new SystemdContainer();
  let wizardOutput = "";

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
    const wizard = await container.user("expect ~/wizard.exp", 300_000);
    wizardOutput = wizard.stdout + wizard.stderr;
    if (wizard.exitCode !== 0) {
      throw new Error(`worker init exited ${wizard.exitCode}:\n${wizardOutput}`);
    }
  }, 900_000);

  afterAll(async () => {
    await container.dispose();
  });

  test("the wizard installs an enabled, running unit that points at the global install", async () => {
    expect(wizardOutput).toContain("devintern-worker service installed and running.");
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
    expect(
      (await container.user("systemctl --user is-enabled devintern-worker")).stdout.trim(),
    ).toBe("enabled");
    expect(await container.unitProperty("ActiveState")).toBe("active");
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
    await container.checkedUser(`kill -KILL ${before}`);
    // RestartSec=30 in the generated unit.
    await container.waitFor(
      "systemd to restart the crashed worker",
      async () =>
        (await container.unitProperty("ActiveState")) === "active" &&
        !["0", before].includes(await container.unitProperty("MainPID")),
      90_000,
    );
    expect(await container.unitProperty("NRestarts")).toBe("1");
  }, 120_000);

  test("re-running the wizard updates the managed unit in place", async () => {
    const again = await container.user("expect ~/wizard.exp", 300_000);
    const output = again.stdout + again.stderr;
    expect(again.exitCode, output).toBe(0);
    expect(output).toContain("devintern-worker service updated and restarted.");
    expect(await container.unitProperty("ActiveState")).toBe("active");
    const units = await container.checkedUser("ls ~/.config/systemd/user");
    expect(units.split("\n").filter((name) => name.endsWith(".service"))).toEqual([
      "devintern-worker.service",
    ]);
  }, 320_000);
});
