import { readFileSync } from "fs";
import { detectSandboxProviders, resolveHarness } from "@devintern/agent-harness";
import { getLoadedEnvPath, loadEnvironment } from "../cli/bootstrap";
import { buildSandboxDoctorReport } from "./sandbox";

/**
 * `devintern sandbox` — report detected providers, remaining setup steps, and
 * what the next run will do with the current configuration. Exits non-zero when
 * the configured provider guarantees a failed run, so scripts/CI can gate.
 */
export async function runSandboxCommand(): Promise<never> {
  loadEnvironment();
  const detections = await detectSandboxProviders();
  const configured = process.env.AGENT_SANDBOX || "none";
  // Attribute the value to the .env file only when that file actually sets it;
  // dotenv merges into process.env, so the two are indistinguishable after
  // loading.
  const loadedEnvPath = getLoadedEnvPath();
  const envFileSetsIt = (() => {
    try {
      return loadedEnvPath
        ? /^\s*AGENT_SANDBOX\s*=/m.test(readFileSync(loadedEnvPath, "utf-8"))
        : false;
    } catch {
      return false;
    }
  })();
  const configuredSource = process.env.AGENT_SANDBOX
    ? envFileSetsIt
      ? (loadedEnvPath as string)
      : "environment"
    : "default";
  const harnessName = resolveHarness().harness.name;
  const report = buildSandboxDoctorReport(detections, configured, configuredSource, harnessName);
  console.log(report.lines.join("\n"));
  process.exit(report.nextRunFails ? 1 : 0);
}
