/**
 * Side-effect-free push-permission probe for `worker doctor`: can the
 * worker's git credentials push to a remote it has no local clone of yet?
 *
 * Read access proves nothing about pushing: a token for a public repository,
 * or a fine-grained token with only Contents: Read, passes `git ls-remote`
 * and the REST API, and the task then fails at `git push`. The probe asks for
 * a dry-run deletion of a ref that does not exist, from an empty scratch
 * repository: git authenticates against `git-receive-pack` (the push path)
 * and changes nothing, so it fails with 403 exactly when a real push would.
 */

import { execFile } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Ref named by the probe; a dry run never creates or deletes it. */
export const PUSH_PROBE_REF = "refs/heads/__devintern_push_probe__";

/** `ok`: a push is accepted. `denied`: the credentials cannot push. `unknown`: anything else. */
export type PushProbeOutcome =
  | { status: "ok" }
  | { status: "denied"; reason: string }
  | { status: "unknown"; reason: string };

/** Classify the probe's exit and stderr. Pure; exported for tests. */
export function classifyPushDryRun(success: boolean, stderr: string): PushProbeOutcome {
  if (success) return { status: "ok" };
  const firstLine =
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "git push --dry-run failed";
  if (
    /permission to .* denied|denied to\b|returned error: 40[13]\b|\b403\b|write access to repository not granted/i.test(
      stderr,
    )
  ) {
    return { status: "denied", reason: firstLine };
  }
  return { status: "unknown", reason: firstLine };
}

/**
 * Run the dry-run push against `remote` with `env` (the caller adds the
 * credential helper and the no-prompt settings).
 *
 * @param env - Environment for the git argv (credential helper plus no-prompt settings).
 */
export function gitPushDryRun(
  remote: string,
  env: (args: readonly string[]) => Record<string, string | undefined>,
  timeoutMs: number,
): Promise<PushProbeOutcome> {
  const scratch = mkdtempSync(join(tmpdir(), "devintern-push-probe-"));
  const finish = (outcome: PushProbeOutcome) => {
    rmSync(scratch, { recursive: true, force: true });
    return outcome;
  };
  return new Promise((resolvePromise) => {
    execFile("git", ["init", "-q"], { cwd: scratch, timeout: timeoutMs }, (initError) => {
      if (initError) {
        resolvePromise(finish({ status: "unknown", reason: "git init failed" }));
        return;
      }
      const args = ["push", "--dry-run", "--porcelain", remote, `:${PUSH_PROBE_REF}`];
      execFile(
        "git",
        args,
        { cwd: scratch, env: env(args), timeout: timeoutMs, killSignal: "SIGKILL" },
        (error, _stdout, stderr) => {
          if (error?.killed) {
            resolvePromise(
              finish({ status: "unknown", reason: `timed out after ${timeoutMs / 1000}s` }),
            );
            return;
          }
          resolvePromise(finish(classifyPushDryRun(!error, String(stderr))));
        },
      );
    });
  });
}

/** Fix named when the token can read a GitHub repository but not push to it. */
export const PUSH_FIX =
  "Give GITHUB_TOKEN Contents and Pull requests read and write access to the repository " +
  "(fine-grained token) or the `repo` scope (classic token); for GitHub Issues also Issues read and write";

/** `permissions` from a `GET /repos/{owner}/{repo}` response, when it has them. */
export async function readRepoPermissions(
  response: Response,
): Promise<{ push?: boolean } | undefined> {
  try {
    const body = (await response.json()) as { permissions?: { push?: unknown } } | null;
    const push = body?.permissions?.push;
    return typeof push === "boolean" ? { push } : undefined;
  } catch {
    return undefined;
  }
}
