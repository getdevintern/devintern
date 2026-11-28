/**
 * Text output renders the human form of each next step (interactive
 * commands, messages for a person); the `--json` documents keep the agent
 * form unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { signInHint, workerLoginCommandFor } from "../src/lib/account/worker-pilot";
import {
  humanCommand,
  humanNextStep,
  humanText,
  renderNextSteps,
} from "../src/lib/observability/next-steps-text";
import { renderReadinessReport } from "../src/lib/observability/readiness";
import type { ReadinessCheck } from "../src/lib/observability/readiness";
import {
  blockerNextSteps,
  buildWorkerDoctorReport,
  connectStep,
  serviceStep,
  signInStep,
} from "../src/lib/observability/readiness-json";
import { workerDoctorClosingLine } from "../src/lib/observability/worker-readiness";
import { renderServiceReport, runWorkerServiceCommand } from "../src/lib/worker/service-command";
import type { ServiceCommandReport } from "../src/lib/worker/service-command";
import type { WorkerServiceDeps } from "../src/lib/worker/service";

let workspaceDir: string;
let configPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "next-steps-text-"));
  configPath = join(workspaceDir, "workspace.toml");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** The entitlement row before anyone signed in (as `worker doctor` reports it). */
function notSignedIn(): ReadinessCheck {
  return {
    id: "entitlement",
    label: "Automation entitlement",
    status: "action",
    detail: "Not started: sign in to begin your 14-day free Worker Pilot, no card required",
    hint: signInHint(workerLoginCommandFor(configPath)),
  };
}

function expectNoAgentFlags(text: string): void {
  expect(text).not.toContain("--no-wait");
  expect(text).not.toContain("--json");
}

describe("humanNextStep", () => {
  test("sign-in becomes the interactive login with a message for a person", () => {
    const step = humanNextStep(signInStep(workspaceDir));
    expect(step.command).toBe(`devintern worker login --workspace ${configPath}`);
    expect(step.message).toContain("opens your browser");
    expect(step.message).not.toContain("--complete");
    // --no-relay is the user's choice and stays.
    expect(humanNextStep(signInStep(workspaceDir, undefined, { noRelay: true })).command).toBe(
      `devintern worker login --workspace ${configPath} --no-relay`,
    );
  });

  test("service and connect drop --json and --no-wait", () => {
    expect(humanNextStep(serviceStep(workspaceDir)).command).toBe(
      `DEVINTERN_WORKSPACE_DIR=${workspaceDir} devintern worker service install`,
    );
    const connect = humanNextStep(connectStep(workspaceDir));
    expect(connect.command).toBe(`devintern worker connect github --workspace ${configPath}`);
    expect(connect.message).toContain("Approve the GitHub App in your browser");
  });

  test("commands quoted in a message lose the machine flags too", () => {
    const [install] = blockerNextSteps(
      [{ id: "harness", label: "Agent harness", status: "fail", detail: "claude not found" }],
      { workspaceDir, env: {}, which: () => "/usr/bin/npm" },
    );
    const human = humanNextStep(install!);
    expect(human.message).toContain(`\`devintern worker doctor --workspace ${configPath}\``);
    expectNoAgentFlags(human.message);
  });

  test("keeps the flags the user passed", () => {
    const command = "devintern worker login github --no-wait --json";
    expect(humanCommand(command)).toBe("devintern worker login github");
    expect(humanCommand(command, { passedFlags: ["--json"] })).toBe(
      "devintern worker login github --json",
    );
    const step = humanNextStep(signInStep(workspaceDir), { passedFlags: ["--no-wait"] });
    expect(step.command).toBe(`devintern worker login --workspace ${configPath} github --no-wait`);
  });

  test("the sign-in hint drops its no-terminal alternative", () => {
    const hint = humanText(signInHint(workerLoginCommandFor(configPath)));
    expect(hint).toBe(
      `Sign in to start your free 14-day Worker Pilot: \`devintern worker login --workspace ${configPath}\` ` +
        "(no card required). Already have a Supporter, Team, or Business license? Set LICENSE_KEY " +
        "in the workspace .env instead. See https://devintern.com/docs/code/worker#worker-pilot-and-licenses.",
    );
  });

  test("complete-sign-in keeps the JSON message's after-sign-in note", () => {
    const step = (suffix: string) => ({
      id: "complete-sign-in",
      message:
        "A person opens the sign-in url in any browser and signs in. The browser then lands on a " +
        "127.0.0.1 page that does not load: pass that page's full address to this command on this host" +
        suffix,
      command: "devintern worker login --complete '<address>'",
    });
    const full = humanNextStep(
      step(". It also pairs the relay and installs and starts the worker service"),
    );
    expect(full.message).toStartWith("Open the sign-in address in any browser");
    expect(full.message).toEndWith(
      "into this command on this host. It also pairs the relay and installs and starts the worker service",
    );
    expect(humanNextStep(step("")).message).toEndWith("into this command on this host");
  });

  test("renderNextSteps numbers each step with its command below", () => {
    expect(renderNextSteps([serviceStep(workspaceDir)], { indent: "  " })).toEqual([
      expect.stringMatching(/^ {2}1\. Install and start the worker as a background service/),
      `     DEVINTERN_WORKSPACE_DIR=${workspaceDir} devintern worker service install`,
    ]);
  });
});

describe("worker service install before sign-in", () => {
  const linux: WorkerServiceDeps = {
    platform: "linux",
    homedir: "/home/tester",
    username: "tester",
    run: async () => ({ status: 0, stdout: "", stderr: "" }),
  };

  async function runInstall(argv: string[]) {
    const out: string[] = [];
    let written = "";
    const code = await runWorkerServiceCommand(argv, {
      workspaceDir,
      service: linux,
      collectReadiness: async () => [notSignedIn()],
      log: (line) => out.push(line),
      error: (line) => out.push(line),
      write: (text) => {
        written += text;
      },
    });
    return { code, text: out.join("\n"), written };
  }

  test("text output prints the human next steps", async () => {
    const { code, text } = await runInstall(["install"]);
    expect(code).toBe(2);
    expectNoAgentFlags(text);
    expect(text).toContain(`devintern worker login --workspace ${configPath}\n`);
    expect(text).toContain(
      `DEVINTERN_WORKSPACE_DIR=${workspaceDir} devintern worker service install`,
    );
    expect(text).toContain("opens your browser");
  });

  test("--json keeps the agent form of every step", async () => {
    const { code, written } = await runInstall(["install", "--json"]);
    expect(code).toBe(2);
    const report = JSON.parse(written) as ServiceCommandReport;
    expect(report.nextSteps).toEqual([
      {
        ...signInStep(workspaceDir),
        command: `devintern worker login --workspace ${configPath} github --no-wait --json`,
      },
      {
        id: "service",
        message: "Then install the service (or pass --force to install it anyway)",
        command: `DEVINTERN_WORKSPACE_DIR=${workspaceDir} devintern worker service install --json`,
      },
    ]);
    expect(report.nextSteps[0]?.message).toContain("the --complete command");
  });

  test("a still-starting or failed start renders without --json", () => {
    const report: ServiceCommandReport = {
      schema: "devintern.worker-service",
      version: 1,
      action: "install",
      result: "starting",
      workspaceDir,
      warnings: [],
      nextSteps: [
        { id: "check-start", message: "Check", command: "devintern worker service status --json" },
        { id: "restart", message: "Restart", command: "devintern worker service restart --json" },
      ],
    };
    const text = renderServiceReport(report, "linux").join("\n");
    expectNoAgentFlags(text);
    expect(text).toContain("devintern worker service status\n");
    expect(text).toContain("devintern worker service restart");
  });
});

describe("worker doctor before sign-in", () => {
  test("the checklist and closing line name the interactive sign-in", () => {
    const checks = [notSignedIn()];
    const report = renderReadinessReport(checks);
    const text = [...report.lines, workerDoctorClosingLine(checks, report)].join("\n");
    expectNoAgentFlags(text);
    expect(text).toContain(`\`devintern worker login --workspace ${configPath}\``);
    expect(text).not.toContain("worker login github");
  });

  test("--json keeps the hint and the agent next steps", () => {
    const doc = buildWorkerDoctorReport([notSignedIn()], {
      workspaceDir,
      offline: false,
      env: {},
    });
    expect(doc.checks[0]?.hint).toBe(signInHint(workerLoginCommandFor(configPath)));
    expect(doc.checks[0]?.hint).toContain("--no-wait");
    expect(doc.nextSteps).toEqual([signInStep(workspaceDir)]);
    expect(doc.nextSteps[0]?.command).toBe(
      `devintern worker login --workspace ${configPath} github --no-wait --json`,
    );
  });
});

describe("worker connect step", () => {
  test("text renders the interactive connect; JSON keeps --no-wait --json", () => {
    const step = connectStep(workspaceDir);
    expect(step.command).toBe(
      `devintern worker connect github --no-wait --json --workspace ${configPath}`,
    );
    const text = renderNextSteps([step]).join("\n");
    expectNoAgentFlags(text);
    expect(text).toContain(`devintern worker connect github --workspace ${configPath}`);
  });
});
