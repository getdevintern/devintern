import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectTrackers, getActiveTrackerId } from "../helpers/tracker-smoke";
import {
  mergeWorkspaceEnv,
  readWorkspaceEnv,
  resolveWorkspaceEnvPath,
} from "../helpers/workspace-env";

// Read-only tracker smoke: reads the worker's shared env, prints which trackers
// are configured, then runs only read-only checks. No ticket is created,
// changed, commented on, or deleted.
const envPath = resolveWorkspaceEnvPath();
if (!existsSync(envPath)) {
  console.error(`Workspace env file not found: ${envPath}`);
  console.error("Set DEVINTERN_ENV_FILE or DEVINTERN_WORKSPACE_DIR before running test:trackers.");
  process.exit(1);
}

const workspaceEnv = readWorkspaceEnv(envPath);
const env = mergeWorkspaceEnv(workspaceEnv.values);
const activeTracker = getActiveTrackerId(env);
const candidates = detectTrackers(env);
const configured = candidates.filter((candidate) => candidate.configured);
const supported = configured.filter((candidate) => candidate.check.run !== undefined);
const unsupported = configured.filter((candidate) => candidate.check.run === undefined);
const activeCandidate = candidates.find((candidate) => candidate.check.id === activeTracker);

console.log(`Workspace env: ${envPath}`);
console.log(
  `Active tracker: ${activeTracker}${
    activeCandidate && !activeCandidate.configured
      ? ` (missing ${activeCandidate.missing.join(", ")})`
      : ""
  }`,
);
console.log(
  `Configured trackers: ${configured.map((candidate) => candidate.check.id).join(", ") || "none"}`,
);
if (unsupported.length > 0) {
  console.log(
    `Configured but not checked yet: ${unsupported
      .map((candidate) => candidate.check.id)
      .join(", ")}`,
  );
}
if (supported.length === 0) {
  console.error(
    "No configured tracker has a read-only check. Configure Jira, Trello, or Markdown, " +
      "or extend helpers/tracker-smoke.ts (see docs/tracker-e2e-plan.md).",
  );
  process.exit(1);
}

const childEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") childEnv[key] = value;
}
childEnv.DEVINTERN_E2E_TRACKERS = "1";
childEnv.DEVINTERN_ENV_FILE = envPath;

const child = Bun.spawn([process.execPath, "test", "./tests/trackers"], {
  cwd: resolve(import.meta.dir, ".."),
  env: childEnv,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
