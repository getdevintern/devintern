/**
 * Text rendering of the `worker init --non-interactive` report (the `--json`
 * document is the report itself).
 */

import { renderPendingSignIn } from "../account/cli";
import { WORKER_PILOT_OFFER, signInCommand } from "../account/worker-pilot";
import type {
  CheckStatus,
  InitCheck,
  NonInteractiveInitReport,
} from "./worker-init-noninteractive";

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: "✅",
  warn: "⚠️ ",
  action: "👉",
  fail: "❌",
  skipped: "⏭️ ",
};

const TOKEN_SOURCE_LABEL = {
  env: "the environment (GITHUB_TOKEN)",
  "env-file": "an env file",
  gh: "the GitHub CLI (`gh auth token`)",
} as const;
/** Checks about this machine rather than the input: the agent CLI and its sandbox. */
const HOST_CHECKS = new Set(["harness", "sandbox"]);
/** Next steps that fix a host check. */
const HOST_STEPS = new Set(["install-agent", "fix-sandbox"]);

/**
 * `items` with the host problems first, the rest in their original order.
 * Text only: the `--json` document keeps the report's order.
 */
function hostProblemsFirst<T>(items: readonly T[], isHostProblem: (item: T) => boolean): T[] {
  return [...items.filter(isHostProblem), ...items.filter((item) => !isHostProblem(item))];
}

/** Last line of the text report: ready, only sign-in left, or failed checks to fix. */
function closingLine(report: NonInteractiveInitReport, failed: InitCheck[]): string {
  if (report.result === "success") {
    return "✅ Worker setup complete. Nothing was started or installed.";
  }
  if (report.result === "unchanged") {
    return "✅ Worker setup unchanged: the workspace already had this setup and every check passed.";
  }
  if (report.result === "action_required") {
    const signIn = report.nextSteps.find((step) => step.id === "sign-in");
    const how = report.signIn
      ? `open the address above, then run \`${report.signIn.complete}\` on this host`
      : `run \`${signIn?.command ?? signInCommand()}\``;
    return (
      `👉 Configuration saved. One step left: sign in to begin your ${WORKER_PILOT_OFFER}: ` +
      `${how}, then \`devintern worker doctor\`.`
    );
  }
  return `❌ Worker setup incomplete: ${failed.length} check(s) failed${report.persisted ? "" : "; nothing was saved"}. Follow the next steps above, then re-run the same command.`;
}

/** Human-readable rendering of the report. */
export function renderNonInteractiveReport(report: NonInteractiveInitReport): string[] {
  const lines: string[] = [];
  if (report.error) {
    lines.push(`❌ ${report.error}`);
    for (const step of report.nextSteps) lines.push(`   ${step.message}: ${step.command}`);
    return lines;
  }
  lines.push("", "Checks:");
  const checks = hostProblemsFirst(
    report.checks,
    (check) => HOST_CHECKS.has(check.name) && (check.status === "fail" || check.status === "warn"),
  );
  for (const check of checks) {
    lines.push(`  ${STATUS_ICON[check.status]} ${check.name}: ${check.message}`);
    if (check.hint) lines.push(`     → ${check.hint}`);
  }
  if (report.tokenSource) {
    lines.push("", `🔑 GitHub token from ${TOKEN_SOURCE_LABEL[report.tokenSource]}.`);
  }
  if (report.signIn) {
    lines.push("", `🔑 Sign in to begin your ${WORKER_PILOT_OFFER}:`);
    for (const line of renderPendingSignIn(report.signIn)) lines.push(`   ${line}`);
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    hostProblemsFirst(report.nextSteps, (step) => HOST_STEPS.has(step.id)).forEach(
      (step, index) => {
        lines.push(`  ${index + 1}. ${step.message}:`);
        lines.push(`     ${step.command}`);
      },
    );
  }
  for (const warning of report.warnings) lines.push("", `⚠️  ${warning}`);
  const failed = report.checks.filter((check) => check.status === "fail");
  lines.push("", closingLine(report, failed));
  return lines;
}
