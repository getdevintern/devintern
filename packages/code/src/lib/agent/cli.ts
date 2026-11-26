import {
  activeSandboxName,
  describeNonoPack,
  detectSandboxProviders,
  getHarness,
  parseHarnessList,
  resolveHarness,
} from "@devintern/agent-harness";
import { bootstrapCheckoutEnv, checkoutEnvSource } from "../cli/checkout-env";
import { hasHelpArg } from "../cli/help";
import { buildSandboxDoctorReport, collectHarnessPreflight } from "./sandbox";

const SANDBOX_USAGE = [
  "Usage: devintern sandbox",
  "",
  "Report detected sandbox providers, the one-time setup each still needs, and",
  "what the next agent run will do with the current AGENT_SANDBOX configuration.",
  "Exits non-zero when the configured provider guarantees a failed run.",
  "",
  "Options:",
  "  -h, --help  Display this help message",
].join("\n");

/**
 * `devintern sandbox` — report detected providers, remaining setup steps, and
 * what the next run will do with the current configuration. Exits non-zero when
 * the configured provider guarantees a failed run, so scripts/CI can gate.
 */
export async function runSandboxCommand(): Promise<never> {
  if (hasHelpArg(process.argv.slice(2))) {
    console.log(SANDBOX_USAGE);
    process.exit(0);
  }
  // A registered checkout reads the workspace env layers, like a task run.
  const workspaceRun = await bootstrapCheckoutEnv();
  const detections = await detectSandboxProviders();
  const configured = process.env.AGENT_SANDBOX || "none";
  // Attribute the value to an env file only when that file actually sets it;
  // dotenv merges into process.env, so the two are indistinguishable after
  // loading.
  const configuredSource = process.env.AGENT_SANDBOX
    ? (checkoutEnvSource(workspaceRun, "AGENT_SANDBOX") ?? "environment")
    : "default";
  const requested = parseHarnessList(process.env.AGENT_HARNESS);
  // Pack-profile status per chain entry: shows which harness runs are backed
  // by a nono pack and which fall back to the generic profile.
  const harnessChain = requested
    .map((name) => getHarness(name)?.name)
    .filter((name): name is string => name !== undefined);
  // `resolveHarness()` (interactive and PR-review runs) takes the first
  // AGENT_HARNESS entry and throws when it is unknown; report that as a failed
  // next run instead of crashing before the report prints.
  const unknownPrimary = getHarness(requested[0] ?? "") ? undefined : requested[0];
  const harnessName = unknownPrimary
    ? (harnessChain[0] ?? requested[0]!)
    : resolveHarness().harness.name;
  const activeSandbox = activeSandboxName();
  const preflight = await collectHarnessPreflight(configured, detections, undefined, activeSandbox);
  const packStatuses = harnessChain.map((name) => describeNonoPack(name));
  const report = buildSandboxDoctorReport(
    detections,
    configured,
    configuredSource,
    harnessName,
    process.platform,
    { activeSandbox, harnessChain, packStatuses, preflight, unknownPrimary },
  );
  console.log(report.lines.join("\n"));
  process.exit(report.nextRunFails ? 1 : 0);
}
