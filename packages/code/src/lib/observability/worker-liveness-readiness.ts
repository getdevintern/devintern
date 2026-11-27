/**
 * `Worker` liveness row and closing line of `devintern worker doctor`, split
 * out of `worker-readiness.ts`.
 */
import type { WorkerStatusView } from "./dashboard-api";
import { humanText } from "./next-steps-text";
import type { ReadinessCheck } from "./readiness";

/**
 * `Worker` row for a running or unverifiable worker; `undefined` when the
 * worker is stopped or there is no lock, so that report stays unchanged.
 */
export function workerLivenessCheck(worker: WorkerStatusView): ReadinessCheck | undefined {
  if (worker.status === "running") {
    const facts = [
      worker.pid === undefined ? undefined : `pid ${worker.pid}`,
      worker.startedAt ? `since ${worker.startedAt}` : undefined,
    ].filter(Boolean);
    return {
      id: "worker",
      label: "Worker",
      status: "ok",
      detail: facts.length > 0 ? `running (${facts.join(", ")})` : "running",
    };
  }
  if (worker.status === "unknown" && worker.reason === "pid-namespace") {
    return {
      id: "worker",
      label: "Worker",
      status: "warn",
      detail: "unknown (cannot verify from this sandbox)",
      hint: "Run `devintern worker status` on the host to see whether a worker is running",
    };
  }
  return undefined;
}

/**
 * Closing line of `devintern worker doctor`, chosen from the report and the
 * `worker` row (if any) in `checks`. Never tells the operator to start a
 * worker that is already running or could not be verified.
 */
export function workerDoctorClosingLine(
  checks: ReadinessCheck[],
  report: { hasFailures: boolean; hasWarnings: boolean; hasActions?: boolean },
): string {
  if (report.hasFailures) {
    return "❌ Not ready — the worker would sit idle or fail. Fix the checks above.";
  }
  if (report.hasActions) {
    const steps = checks
      .filter((check) => check.status === "action")
      .map((check) => (check.hint ? humanText(check.hint) : (check.detail ?? check.label)));
    return `👉 Setup is fine; one step left before the worker can start. ${steps.join(" ")}`;
  }
  const worker = checks.find((check) => check.id === "worker");
  if (worker?.status === "ok") {
    const reload =
      "config changes hot-reload; restart-only settings need a restart (see docs/code/workspaces.md).";
    return report.hasWarnings
      ? `✅ A worker is already running (with the warnings above) — ${reload}`
      : `✅ Everything looks good — a worker is already running; ${reload}`;
  }
  if (worker) {
    return "✅ Ready to run (with the warnings above); could not tell whether a worker is already running — check with `devintern worker status` on the host.";
  }
  return report.hasWarnings
    ? "✅ Ready to run (with the warnings above) — start it with `devintern worker`."
    : "✅ Everything looks good — start the worker with `devintern worker`.";
}
