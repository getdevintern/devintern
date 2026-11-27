/**
 * `devintern worker init` host checks: the wizard reports a missing agent CLI
 * or git before its first question and does not repeat the failure in the
 * closing readiness block; the non-interactive text report lists host
 * problems first while the JSON keeps its order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { runWorkerInit } from "../src/lib/init/worker-init";
import { defaultCheckHost } from "../src/lib/init/worker-init-host";
import {
  emptyInitReport,
  parseNonInteractiveInitArgs,
} from "../src/lib/init/worker-init-noninteractive";
import { renderNonInteractiveReport } from "../src/lib/init/worker-init-noninteractive-text";
import type { HostChecks } from "../src/lib/init/worker-init-run";
import type { ReadinessCheck } from "../src/lib/observability/readiness";

const MISSING_AGENT: ReadinessCheck = {
  id: "harness",
  label: "Agent harness",
  status: "fail",
  detail: "no harness CLI found for AGENT_HARNESS=claude-code",
  hint: "Install the agent CLI, or set AGENT_HARNESS / <HARNESS>_CLI_PATH in the workspace .env",
};

const INSTALL_AGENT = {
  id: "install-agent",
  message: "Install the agent CLI (Claude Code) on this host.",
  command: "npm install -g @anthropic-ai/claude-code",
};

describe("worker init host checks (wizard)", () => {
  let tempDir: string;
  let workspaceDir: string;
  let logs: string[];
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ["TASK_TRACKER", "DEVINTERN_WORKSPACE_DIR", "LICENSE_KEY"];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-worker-host-"));
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

  /** Hermetic wizard deps recording questions and the order of events. */
  function deps(host: HostChecks, answer: (question: string) => string = () => "") {
    const events: string[] = [];
    return {
      events,
      deps: {
        cwd: tempDir,
        log: (message: string) => {
          logs.push(message);
          events.push(`log:${message}`);
        },
        prompt: async (question: string) => {
          events.push(`ask:${question}`);
          return question.startsWith("Ready-tasks query") ? "status=todo" : answer(question);
        },
        checkHost: async () => host,
        ensureTracker: async () => {
          events.push("tracker");
          return "markdown";
        },
        bootstrapWorkspace: async () => ({ workspaceDir, repoName: "app" }),
        detectGithubRepo: async () => null,
        noService: true,
        getUser: async () => null,
        signIn: async () => null,
        collectReadiness: async () => [MISSING_AGENT],
      },
    };
  }

  test("a missing agent CLI is the first thing reported, with the install command", async () => {
    const { events, deps: d } = deps({
      harness: MISSING_AGENT,
      git: "/usr/bin/git",
      installAgent: INSTALL_AGENT,
    });
    const result = await runWorkerInit(d);
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(false);

    const firstProblem = events.findIndex((event) => event.includes("❌"));
    expect(events[firstProblem]).toContain("❌ Agent CLI: no harness CLI found");
    // Reported (and asked about) before the tracker step.
    const continueAt = events.findIndex((event) =>
      event.startsWith("ask:Continue setup without the agent CLI?"),
    );
    expect(firstProblem).toBeLessThan(continueAt);
    expect(continueAt).toBeLessThan(events.indexOf("tracker"));
    const output = logs.join("\n");
    expect(output).toContain(`Install it with: ${INSTALL_AGENT.command}`);

    // The readiness block keeps the row but not the failure text and hint again.
    expect(output).toContain("❌ Agent harness — still missing (see the host check at the start)");
    expect(output.split(MISSING_AGENT.hint!).length - 1).toBe(0);
    // The closing next step names the install command.
    expect(output).toContain(`Agent harness: install the agent CLI (run ${INSTALL_AGENT.command})`);
  });

  test('"n" at the continue question stops before the tracker step', async () => {
    const { events, deps: d } = deps(
      { harness: MISSING_AGENT, git: null, installAgent: INSTALL_AGENT },
      (question) => (question.startsWith("Continue setup") ? "n" : ""),
    );
    const result = await runWorkerInit(d);
    expect(result.ok).toBe(false);
    expect(events).not.toContain("tracker");
    expect(logs.join("\n")).toContain("❌ git: not found on PATH");
    expect(
      events.some((event) => event.startsWith("ask:Continue setup without the agent CLI and git?")),
    ).toBe(true);
    expect(logs.join("\n")).toContain("Setup stopped. Install the agent CLI and git");
  });

  test("a ready host asks nothing and the service manager is info only", async () => {
    const { events, deps: d } = deps({
      harness: { id: "harness", label: "Agent harness", status: "ok", detail: "claude-code" },
      git: "/usr/bin/git",
      serviceManager: { available: false, reason: "systemctl is not installed" },
    });
    d.collectReadiness = async () => [];
    const result = await runWorkerInit(d);
    expect(result.ok).toBe(true);
    expect(events.some((event) => event.startsWith("ask:Continue setup"))).toBe(false);
    const output = logs.join("\n");
    expect(output).toContain("✅ Agent CLI: claude-code");
    expect(output).toContain(
      "ℹ️  Background service: not available here (systemctl is not installed)",
    );
    expect(output).not.toContain("❌");
  });

  test("defaultCheckHost finds no agent CLI on an empty PATH and suggests the installer", async () => {
    const emptyBin = path.join(tempDir, "bin");
    mkdirSync(emptyBin);
    const host = await defaultCheckHost({
      processEnv: { PATH: emptyBin, AGENT_HARNESS: "claude-code" },
      workspaceDir,
      noService: true,
      which: () => null,
    });
    expect(host.harness.status).toBe("fail");
    expect(host.git).toBeNull();
    expect(host.serviceManager).toBeUndefined();
    expect(host.installAgent?.id).toBe("install-agent");
    expect(host.installAgent?.command).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  });
});

describe("worker init --non-interactive host problems", () => {
  test("the text report lists host problems first; the JSON order is unchanged", () => {
    const report = {
      ...emptyInitReport("/tmp/ws"),
      result: "failure" as const,
      checks: [
        { name: "tracker-auth", label: "Tracker", status: "pass" as const, message: "ok" },
        { name: "query", label: "Query", status: "warn" as const, message: "0 matches" },
        { name: "harness", label: "Agent harness", status: "fail" as const, message: "missing" },
      ],
      nextSteps: [
        {
          id: "service",
          message: "Install the service",
          command: "devintern worker service install",
        },
        { id: "install-agent", message: "Install the agent CLI", command: "npm i -g x" },
      ],
    };
    const lines = renderNonInteractiveReport(report);
    const checkLines = lines.filter((line) => /^ {2}\S+ \S+: /.test(line));
    expect(checkLines[0]).toContain("harness: missing");
    const steps = lines.filter((line) => /^ {2}\d+\. /.test(line));
    expect(steps[0]).toBe("  1. Install the agent CLI");
    expect(report.checks.map((check) => check.name)).toEqual(["tracker-auth", "query", "harness"]);
    expect(report.nextSteps.map((step) => step.id)).toEqual(["service", "install-agent"]);
  });

  test("--customize is refused with --non-interactive", () => {
    const parsed = parseNonInteractiveInitArgs(["--non-interactive", "--customize"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--customize asks each worker setting");
  });
});
