/**
 * `worker doctor` "CI status access" rows: one per GitHub repository whose
 * runs read commit CI state (`[workspace].auto_merge` or `ci_failure_fix`),
 * probed with the credential those runs use. See
 * `code-host/github/ci-permission-probe.ts` for what each permission means.
 */

import type { CiProbeFetch, CiProbeStatus } from "../code-host/github/ci-permission-probe";
import {
  ciPermissionProbeSlug,
  probeRepoCiPermissions,
  workspaceUsesHostedGitHubApp,
} from "../workspace/ci-permission-check";
import type { RepoCiPermissionOutcome } from "../workspace/ci-permission-check";
import type { WorkspaceConfig } from "../workspace/config";
import type { ReadinessCheck, ReadinessStatus } from "./readiness";

type Env = Record<string, string | undefined>;

const BASE = { id: "ci-permissions", label: "CI status access" } as const;

/** Injectable network layer for the CI-permission rows (tests). */
export interface CiPermissionDoctorDeps {
  /** HTTP layer of the probe. Defaults to global `fetch`. */
  ciProbeFetch?: CiProbeFetch;
  /** Whether GitHub events arrive through the hosted relay App (`token-only` auth). */
  usesHostedGitHubApp?: (workspaceDir: string) => Promise<boolean>;
}

const ROW_STATUS: Record<CiProbeStatus, ReadinessStatus> = {
  ok: "ok",
  info: "ok",
  warn: "warn",
  fail: "fail",
};

/** Render one repository's probe outcome as a doctor row. */
export function ciPermissionRow(name: string, outcome: RepoCiPermissionOutcome): ReadinessCheck {
  if (outcome.kind === "no-credential") {
    return {
      ...BASE,
      status: "warn",
      detail: `${name}: not checked (no GITHUB_TOKEN or GitHub App configured)`,
      hint: "Set GITHUB_TOKEN so auto-merge and CI fixes can read CI status",
    };
  }
  const { result } = outcome;
  const hints = result.findings.flatMap((finding) => (finding.hint ? [finding.hint] : []));
  const via = outcome.credential === "app" ? "GitHub App" : "GITHUB_TOKEN";
  return {
    ...BASE,
    status: ROW_STATUS[result.status],
    detail: `${name} (${via}): ${result.findings.map((finding) => finding.detail).join("; ")}`,
    ...(hints.length > 0 ? { hint: [...new Set(hints)].join(" ") } : {}),
  };
}

/**
 * CI-permission rows for every repository the probe applies to. Under
 * `offline` each applicable repository gets a skipped warning and nothing
 * touches the network. Never throws.
 */
export async function ciPermissionChecks(input: {
  config: WorkspaceConfig;
  workspaceDir: string;
  processEnv: Env;
  offline: boolean;
  timeoutMs: number;
  deps: CiPermissionDoctorDeps;
}): Promise<ReadinessCheck[]> {
  const { config, workspaceDir, processEnv, offline, timeoutMs, deps } = input;
  const targets = config.repos.flatMap((repo) => {
    const slug = ciPermissionProbeSlug(config, repo);
    return slug ? [{ repo, slug, name: `[[repos]] "${repo.name}" (${slug})` }] : [];
  });
  if (targets.length === 0) return [];
  if (offline) {
    return targets.map(({ name }) => ({
      ...BASE,
      status: "warn",
      detail: `${name}: skipped (--offline)`,
      hint: "Rerun `devintern worker doctor` without --offline to check CI status access",
    }));
  }
  let usesHostedApp = false;
  try {
    usesHostedApp = await (deps.usesHostedGitHubApp ?? workspaceUsesHostedGitHubApp)(workspaceDir);
  } catch {
    usesHostedApp = false;
  }
  const rows: ReadinessCheck[] = [];
  for (const { repo, slug, name } of targets) {
    try {
      const outcome = await probeRepoCiPermissions({
        repo,
        slug,
        ciFailureFix: config.workspace.ciFailureFix,
        workspaceDir,
        processEnv,
        usesHostedApp,
        timeoutMs,
        ...(deps.ciProbeFetch ? { fetch: deps.ciProbeFetch } : {}),
      });
      rows.push(ciPermissionRow(name, outcome));
    } catch (error) {
      rows.push({
        ...BASE,
        status: "warn",
        detail: `${name}: couldn't verify (${error instanceof Error ? error.name : "error"})`,
        hint: "Rerun `devintern worker doctor` once GitHub is reachable",
      });
    }
  }
  return rows;
}
