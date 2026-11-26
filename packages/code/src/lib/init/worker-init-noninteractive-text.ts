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

/** Last line of the text report: ready, only sign-in left, or failed checks to fix. */
function closingLine(report: NonInteractiveInitReport, failed: InitCheck[]): string {
  if (report.result === "success") {
    return "✅ Worker setup complete. Nothing was started or installed.";
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
  return `❌ Worker setup incomplete: ${failed.length} check(s) failed. Fix them and re-run with --yes, or run \`devintern worker doctor\`.`;
}

/** Human-readable rendering of the report. */
export function renderNonInteractiveReport(report: NonInteractiveInitReport): string[] {
  const lines: string[] = [];
  if (report.error) {
    lines.push(`❌ ${report.error}`);
    return lines;
  }
  lines.push("", "Checks:");
  for (const check of report.checks) {
    lines.push(`  ${STATUS_ICON[check.status]} ${check.name}: ${check.message}`);
    if (check.hint) lines.push(`     → ${check.hint}`);
  }
  if (report.signIn) {
    lines.push("", `🔑 Sign in to begin your ${WORKER_PILOT_OFFER}:`);
    for (const line of renderPendingSignIn(report.signIn)) lines.push(`   ${line}`);
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    report.nextSteps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step.message}: ${step.command}`);
    });
  }
  const failed = report.checks.filter((check) => check.status === "fail");
  lines.push("", closingLine(report, failed));
  return lines;
}
