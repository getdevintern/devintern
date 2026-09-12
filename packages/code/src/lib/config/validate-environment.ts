import { flushAnalyticsAndExit } from "../cli/bootstrap";
import { TRACKER_CAPABILITIES, supportedTrackers } from "../trackers/capabilities";
import { printMissingEnvHelp } from "./project-settings";

/**
 * Ensure required environment variables for the configured task tracker are present.
 *
 * Supports `TASK_TRACKER=jira` (default), `trello`, or `markdown`.
 *
 * Exit paths flush pending analytics first so events captured earlier in the
 * run (`cli_run`, `setup_declined`/`setup_failed` from the first-run rescue)
 * are delivered instead of dying with the process.
 *
 * @throws Exits the process when variables are missing
 */
export async function validateEnvironment(): Promise<void> {
  const trackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();
  const capabilities = TRACKER_CAPABILITIES[trackerType];

  if (!capabilities) {
    console.error(`❌ Unsupported task tracker: "${trackerType}"`);
    console.error(`   Supported values: ${supportedTrackers().join(", ")}`);
    await flushAnalyticsAndExit(1);
    return;
  }

  const missing = capabilities.requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`❌ Missing required ${capabilities.displayName} environment variables:`);
    missing.forEach((key) => console.error(`   - ${key}`));
    printMissingEnvHelp();
    await flushAnalyticsAndExit(1);
  }
}
