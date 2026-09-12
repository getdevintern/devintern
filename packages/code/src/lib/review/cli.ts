import { captureError, flushErrorTracking } from "@devintern/utils";
import { loadEnvironment } from "../cli/bootstrap";
import { endRun } from "../state/run-recorder";
import { exitIfWorkerUsageLimit } from "../worker/usage-limit-protocol";

/** `devintern address-review <pr-url>` — manually address PR/MR review feedback. */
export async function runAddressReviewCommand(args: string[]): Promise<void> {
  loadEnvironment();

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

  const { addressReview } = await import("./address");
  try {
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
  loadEnvironment();

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

  const { resolveConflictsOnPr } = await import("./conflict-resolver");
  try {
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
