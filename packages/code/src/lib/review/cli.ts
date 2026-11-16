import { captureError, flushErrorTracking } from "@devintern/utils";
import { loadEnvironment } from "../cli/bootstrap";
import { setManualWorkspaceStateDir } from "../config/config-dir";
import { endRun } from "../state/run-recorder";
import { exitIfWorkerUsageLimit } from "../worker/usage-limit-protocol";
import { workspaceCredentialsForChange } from "../workspace/manual-credentials";
import { ensureWorkspaceCodeState, resolveWorkspaceDir } from "../workspace/paths";

/** Use a registered repo's workspace layers for manual PR commands. */
async function loadReviewEnvironment(changeUrl: string): Promise<void> {
  const credentials = await workspaceCredentialsForChange(changeUrl);
  if (credentials) {
    const workspaceDir = resolveWorkspaceDir();
    ensureWorkspaceCodeState(workspaceDir);
    setManualWorkspaceStateDir(workspaceDir);
    Object.assign(process.env, credentials);
  }
  loadEnvironment(undefined, { skipProjectEnv: Boolean(credentials) });
}

/** `devintern address-review <pr-url>` — manually address PR/MR review feedback. */
export async function runAddressReviewCommand(args: string[]): Promise<void> {
  let prUrl: string | undefined;
  let noPush = false;
  let noReply = false;
  let verbose = false;
  let ciFeedbackPath: string | undefined;
  let expectedHeadSha: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-push") {
      noPush = true;
    } else if (args[i] === "--no-reply") {
      noReply = true;
    } else if (args[i] === "-v" || args[i] === "--verbose") {
      verbose = true;
    } else if (args[i] === "--ci-feedback") {
      const feedbackPath = args[i + 1];
      if (!feedbackPath || feedbackPath.startsWith("-")) {
        console.error("Error: --ci-feedback requires a file path");
        process.exitCode = 1;
        return;
      }
      ciFeedbackPath = feedbackPath;
      i++;
    } else if (args[i] === "--expected-head") {
      const sha = args[i + 1];
      if (!sha || sha.startsWith("-")) {
        console.error("Error: --expected-head requires a commit SHA");
        process.exitCode = 1;
        return;
      }
      expectedHeadSha = sha;
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: devintern address-review <pr-url> [options]");
      console.log("");
      console.log("Manually address pull-request or merge-request feedback using Agent");
      console.log("");
      console.log("Arguments:");
      console.log("  pr-url         GitHub PR or GitLab MR URL");
      console.log("");
      console.log("Options:");
      console.log("  --no-push      Don't push changes after fixing");
      console.log("  --no-reply     Don't post a reply comment on the PR");
      console.log("  -v, --verbose  Enable verbose logging");
      console.log("  -h, --help     Display this help message");
      console.log("");
      console.log("Examples:");
      console.log("  devintern address-review https://github.com/owner/repo/pull/123");
      console.log(
        "  devintern address-review https://gitlab.com/group/project/-/merge_requests/123",
      );
      console.log("  devintern address-review https://github.com/owner/repo/pull/123 --no-push");
      process.exit(0);
    } else if (!args[i].startsWith("-")) {
      prUrl = args[i];
    }
  }

  if (!prUrl) {
    console.error("❌ Error: PR URL is required");
    console.error("");
    console.error("Usage: devintern address-review <pr-url>");
    console.error("Run 'devintern address-review --help' for more information.");
    process.exit(1);
  }

  try {
    await loadReviewEnvironment(prUrl);
    const { addressReview } = await import("./address");
    await addressReview(prUrl, {
      noPush,
      noReply,
      verbose,
      ciFeedbackPath,
      expectedHeadSha,
    });
  } catch (error) {
    if (exitIfWorkerUsageLimit(error)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Close any run record addressReview opened before it failed (no-op
    // when none is active — addressReview also ends runs it completes).
    endRun("failed", message);
    captureError(error, { command: "address-review", prUrl });
    console.error(`❌ Error: ${message}`);
    // This is a handled exception, so the process-level fatal handlers do
    // not run. Flush explicitly before the subprocess reports failure.
    await flushErrorTracking();
    process.exit(1);
  }
}

/**
 * `devintern resolve-conflicts <pr-url>` — catch a PR branch up with its base,
 * resolving merge conflicts with the agent when needed. Also invoked by the
 * worker for its own PRs.
 */
export async function runResolveConflictsCommand(args: string[]): Promise<void> {
  let prUrl: string | undefined;
  let noPush = false;
  let verbose = false;
  let expectedHeadSha: string | undefined;
  let expectedBaseSha: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-push") {
      noPush = true;
    } else if (args[i] === "--expected-head") {
      expectedHeadSha = args[++i];
    } else if (args[i] === "--expected-base") {
      expectedBaseSha = args[++i];
    } else if (args[i] === "-v" || args[i] === "--verbose") {
      verbose = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: devintern resolve-conflicts <pr-url> [options]");
      console.log("");
      console.log("Merge the PR's base branch into its branch, resolving merge");
      console.log("conflicts with the agent when needed, then push (never forced).");
      console.log("");
      console.log("Arguments:");
      console.log("  pr-url         GitHub PR or GitLab MR URL");
      console.log("");
      console.log("Options:");
      console.log("  --no-push      Resolve and commit locally but don't push");
      console.log("  -v, --verbose  Enable verbose logging");
      console.log("  -h, --help     Display this help message");
      process.exit(0);
    } else if (!args[i].startsWith("-")) {
      prUrl = args[i];
    }
  }

  if (!prUrl) {
    console.error("❌ Error: PR URL is required");
    console.error("");
    console.error("Usage: devintern resolve-conflicts <pr-url>");
    process.exit(1);
  }

  try {
    await loadReviewEnvironment(prUrl);
    const { resolveConflictsOnPr } = await import("./conflict-resolver");
    const result = await resolveConflictsOnPr(prUrl, {
      noPush,
      verbose,
      expectedHeadSha,
      expectedBaseSha,
    });
    const resultFd = Number(process.env.DEVINTERN_RESULT_FD);
    if (Number.isInteger(resultFd) && resultFd >= 3) {
      const { writeSync } = await import("fs");
      writeSync(resultFd, `${JSON.stringify(result)}\n`);
    }
    if (result.outcome === "skipped") {
      console.log(`⏭️  Skipped: ${result.message}`);
    } else if (result.outcome === "failed") {
      // A landed-but-unconfirmed failure means the merge commit IS on the
      // PR branch even though verification failed; only the other failure
      // kinds leave the PR untouched.
      const untouchedHint =
        result.failureKind === "landed-but-unconfirmed"
          ? "The merge commit is on the branch; see the PR for details."
          : "No changes landed on the PR; see the PR comment for details.";
      console.error(`❌ Failed: ${result.message}. ${untouchedHint}`);
    } else if (result.outcome === "deferred") {
      console.log(`⏳ Deferred: ${result.message}`);
    }
    process.exitCode = result.outcome === "failed" ? 1 : result.outcome === "deferred" ? 2 : 0;
  } catch (error) {
    if (exitIfWorkerUsageLimit(error)) {
      return;
    }
    console.error(`❌ Error: ${(error as Error).message}`);
    // Thrown (unexpected) resolution errors are user actions that failed —
    // reported like address-review; `failed`/`deferred` outcomes above are
    // expected results and stay unreported.
    captureError(error, { command: "resolve-conflicts", prUrl });
    await flushErrorTracking();
    process.exitCode = 1;
  }
}

/**
 * `devintern auto-merge <pr-url>` — merge a PR when it passes the auto-merge
 * gates (preconditions, path policy, optional agent review). Also invoked by
 * the worker for its own PRs with the workspace's policy as flags.
 */
export async function runAutoMergeCommand(args: string[]): Promise<void> {
  const { AUTO_MERGE_METHODS } = await import("./merge-gate");
  type Method = (typeof AUTO_MERGE_METHODS)[number];
  let prUrl: string | undefined;
  let expectedHeadSha: string | undefined;
  let dryRun = false;
  let lastAttempt = false;
  let review = true;
  let verbose = false;
  let method: Method = "squash";
  const safePaths: string[] = [];
  const denyPaths: string[] = [];

  const takeValue = (flag: string, value: string | undefined): string | undefined => {
    if (!value || value.startsWith("-")) {
      console.error(`Error: ${flag} requires a value`);
      process.exitCode = 1;
      return undefined;
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--safe-path" || arg === "--deny-path" || arg === "--expected-head") {
      const value = takeValue(arg, args[++i]);
      if (value === undefined) return;
      if (arg === "--safe-path") safePaths.push(value);
      else if (arg === "--deny-path") denyPaths.push(value);
      else expectedHeadSha = value;
    } else if (arg === "--method") {
      const value = takeValue(arg, args[++i]);
      if (value === undefined) return;
      if (!(AUTO_MERGE_METHODS as readonly string[]).includes(value)) {
        console.error(`Error: --method must be one of ${AUTO_MERGE_METHODS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      method = value as Method;
    } else if (arg === "--no-review") {
      review = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--last-attempt") {
      // Worker-internal: a failure on this attempt is stated on the PR.
      lastAttempt = true;
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: devintern auto-merge <pr-url> [options]");
      console.log("");
      console.log("Merge a GitHub pull request when it is green, conflict-free, and safe:");
      console.log("PRs that only touch --safe-path globs merge without an agent run; other");
      console.log("PRs merge only when the agent's merge-safety review says so. A");
      console.log("--deny-path hit (or a built-in one such as .github/**) never merges.");
      console.log("");
      console.log("Options:");
      console.log("  --safe-path <glob>     Safe-to-merge glob (repeatable), e.g. 'docs/**'");
      console.log("  --deny-path <glob>     Never-merge glob (repeatable)");
      console.log("  --no-review            Skip the agent review; only safe-path PRs merge");
      console.log("  --method <m>           merge | squash | rebase (default: squash)");
      console.log(
        "  --dry-run              Evaluate every gate, including the review, but don't merge",
      );
      console.log("  -v, --verbose          Enable verbose logging");
      console.log("  -h, --help             Display this help message");
      console.log("");
      console.log("Examples:");
      console.log(
        "  devintern auto-merge https://github.com/owner/repo/pull/123 --safe-path '**/*.md' --dry-run",
      );
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      prUrl = arg;
    }
  }

  if (!prUrl) {
    console.error("❌ Error: PR URL is required");
    console.error("");
    console.error("Usage: devintern auto-merge <pr-url>");
    process.exit(1);
  }

  try {
    await loadReviewEnvironment(prUrl);
    const { autoMergePr } = await import("./auto-merge");
    const result = await autoMergePr(prUrl, {
      policy: { safePaths, denyPaths, review, method },
      expectedHeadSha,
      dryRun,
      lastAttempt,
      verbose,
    });
    const resultFd = Number(process.env.DEVINTERN_RESULT_FD);
    if (Number.isInteger(resultFd) && resultFd >= 3) {
      const { writeSync } = await import("fs");
      writeSync(resultFd, `${JSON.stringify(result)}\n`);
    }
    const icon: Record<typeof result.outcome, string> = {
      merged: "🔀 Merged",
      "would-merge": "✅ Would merge",
      rejected: "🛑 Not merging",
      waiting: "⏳ Not ready",
      skipped: "⏭️  Skipped",
      failed: "❌ Failed",
      deferred: "⏳ Deferred",
    };
    const line = `${icon[result.outcome]}: ${result.message}`;
    if (result.outcome === "failed") console.error(line);
    else console.log(line);
    process.exitCode = result.outcome === "failed" ? 1 : result.outcome === "deferred" ? 2 : 0;
  } catch (error) {
    if (exitIfWorkerUsageLimit(error)) {
      return;
    }
    console.error(`❌ Error: ${(error as Error).message}`);
    captureError(error, { command: "auto-merge", prUrl });
    await flushErrorTracking();
    process.exitCode = 1;
  }
}
