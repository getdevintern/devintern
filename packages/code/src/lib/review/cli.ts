import { captureError, flushErrorTracking } from "@devintern/utils";
import { loadEnvironment } from "../cli/bootstrap";
import { setManualWorkspaceStateDir } from "../config/config-dir";
import { endRun } from "../state/run-recorder";
import { failureFromError } from "../state/run-outcome";
import {
  exitIfWorkerUsageLimit,
  WORKTREE_BUSY_EXIT_CODE,
  WorktreeBusyError,
} from "../worker/usage-limit-protocol";
import { workspaceCredentialsForChange } from "../workspace/manual-credentials";
import { ensureWorkspaceCodeState, resolveWorkspaceDir, workspaceDbPath } from "../workspace/paths";
import { resolveRulesFilePath } from "./merge-safety-rules";
import { parseMentionArg } from "./mention-trigger";
import type { MentionTrigger } from "./mention-trigger";

/** Use a registered repo's workspace layers for manual PR commands. */
async function loadReviewEnvironment(changeUrl: string): Promise<void> {
  const credentials = await workspaceCredentialsForChange(changeUrl);
  if (credentials) {
    const workspaceDir = resolveWorkspaceDir();
    ensureWorkspaceCodeState(workspaceDir);
    setManualWorkspaceStateDir(workspaceDir);
    Object.assign(process.env, credentials);
    // Run records and addressed-feedback state go to this workspace's DB.
    process.env.WEBHOOK_QUEUE_DB ||= workspaceDbPath(workspaceDir);
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
  let mention: MentionTrigger | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-push") {
      noPush = true;
    } else if (args[i] === "--mention") {
      // Worker-internal: the @mention comment or review that triggered this run.
      mention = parseMentionArg(args[i + 1] ?? "");
      if (!mention) {
        console.error("Error: --mention requires <issue_comment|review_comment|review>:<id>");
        process.exitCode = 1;
        return;
      }
      i++;
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
      mention,
    });
  } catch (error) {
    if (exitIfWorkerUsageLimit(error)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WorktreeBusyError) {
      // Another job holds the worktree: defer without a failed run or an
      // error report; the parent maps this exit code to "deferred".
      endRun("deferred", message);
      console.warn(`⏳ ${message}`);
      process.exit(WORKTREE_BUSY_EXIT_CODE);
    }
    // Close any run record addressReview opened before it failed (no-op
    // when none is active — addressReview also ends runs it completes).
    endRun("failed", message, { failure: failureFromError(error, "address_review") });
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

type MergeGateModule = typeof import("./merge-gate");

/** Flags of `devintern auto-merge`, parsed. */
interface AutoMergeCommandArgs {
  prUrl?: string;
  expectedHeadSha?: string;
  dryRun: boolean;
  lastAttempt: boolean;
  /** Worker-internal: the CI wait the PR already shows. */
  ciWaitPosted?: string;
  verbose: boolean;
  policy: import("./auto-merge").AutoMergePolicy;
}

function printAutoMergeHelp(defaultLabel: string): void {
  console.log("Usage: devintern auto-merge <pr-url> [options]");
  console.log("");
  console.log("Merge a GitHub pull request when it is green, conflict-free, and safe:");
  console.log("code PRs need at least one passing CI check (safe-path-only PRs do not);");
  console.log("PRs that only touch --safe-path globs merge without an agent run; other");
  console.log("PRs merge only when the agent's merge-safety review says so. A");
  console.log("--deny-path hit (or a built-in one such as .github/**) never merges, and a");
  console.log("--review-path hit always goes to the review, even if it is also a safe path.");
  console.log("");
  console.log("Options:");
  console.log("  --safe-path <glob>     Safe-to-merge glob (repeatable), e.g. 'docs/**'");
  console.log("  --deny-path <glob>     Never-merge glob (repeatable)");
  console.log("  --review-path <glob>   Always-review glob, never safe (repeatable)");
  console.log("  --no-review            Skip the agent review; only safe-path PRs merge");
  console.log(
    "  --require-checks       Code PRs need at least one passing CI check (failing or pending checks always block)",
  );
  console.log(
    "  --require-approval     Wait until the base branch's required reviews are met, even if this credential could bypass them",
  );
  console.log("  --method <m>           merge | squash | rebase (default: squash)");
  console.log(
    "  --policy <p>           Review rubric: strict | standard | relaxed | custom (default: strict)",
  );
  console.log("  --rules=<text>         custom policy: the rubric text");
  console.log(
    "  --rules-file <path>    custom policy: rubric file, read on each review (relative to the workspace home)",
  );
  console.log("  --review-instructions <text>  Extra repo-specific rules for the review");
  console.log(
    `  --review-label <name>  Label for PRs left open for a human (default: ${defaultLabel})`,
  );
  console.log("  --no-review-label      Don't label PRs left open");
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
}

/** A flag's value; `undefined` (with exit code 1) when missing or not a valid choice. */
function takeFlagValue<T extends string>(
  flag: string,
  value: string | undefined,
  choices?: readonly T[],
): T | undefined {
  if (!value || value.startsWith("-")) {
    console.error(`Error: ${flag} requires a value`);
    process.exitCode = 1;
    return undefined;
  }
  if (choices && !(choices as readonly string[]).includes(value)) {
    console.error(`Error: ${flag} must be one of ${choices.join(", ")}`);
    process.exitCode = 1;
    return undefined;
  }
  return value as T;
}

/** Parse `devintern auto-merge` flags; `undefined` on a usage error (exit code set). Exported for tests. */
export function parseAutoMergeArgs(
  args: string[],
  gate: MergeGateModule,
  workspaceDir: string = resolveWorkspaceDir(),
): AutoMergeCommandArgs | undefined {
  const parsed = parseAutoMergeFlags(args, gate, workspaceDir);
  return parsed && checkCustomRulesUsage(parsed);
}

/** `--flag=<text>` options; `=` form because the text may start with "-". */
const AUTO_MERGE_TEXT_FLAGS = [
  ["--review-instructions=", "reviewInstructions"],
  ["--rules=", "rules"],
] as const;

/** Apply a `--flag=<text>` option; `false` when `arg` is not one. Empty text adds nothing. */
function applyTextFlag(arg: string, policy: AutoMergeCommandArgs["policy"]): boolean {
  for (const [prefix, key] of AUTO_MERGE_TEXT_FLAGS) {
    if (arg.startsWith(prefix)) {
      policy[key] = arg.slice(prefix.length);
      return true;
    }
  }
  return false;
}

/** The list a repeatable `--safe-path` / `--deny-path` / `--review-path` flag appends to. */
function pathListFlag(arg: string, policy: AutoMergeCommandArgs["policy"]): string[] | undefined {
  if (arg === "--safe-path") return policy.safePaths;
  if (arg === "--deny-path") return policy.denyPaths;
  if (arg === "--review-path") return (policy.reviewPaths ??= []);
  return undefined;
}

/** The policy requirement a `--require-checks` / `--require-approval` flag turns on. */
function requirementFlag(arg: string): "requireChecks" | "requireApproval" | undefined {
  if (arg === "--require-checks") return "requireChecks";
  if (arg === "--require-approval") return "requireApproval";
  return undefined;
}

function parseAutoMergeFlags(
  args: string[],
  gate: MergeGateModule,
  workspaceDir: string,
): AutoMergeCommandArgs | undefined {
  const parsed: AutoMergeCommandArgs = {
    dryRun: false,
    lastAttempt: false,
    verbose: false,
    policy: {
      safePaths: [],
      denyPaths: [],
      reviewPaths: [],
      review: true,
      method: "squash",
      reviewLabel: gate.DEFAULT_AUTO_MERGE_REVIEW_LABEL,
      reviewPolicy: gate.DEFAULT_MERGE_SAFETY_POLICY,
    },
  };
  const { policy } = parsed;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const pathList = pathListFlag(arg, policy);
    const requirement = requirementFlag(arg);
    if (pathList) {
      const value = takeFlagValue(arg, args[++i]);
      if (value === undefined) return undefined;
      pathList.push(value);
    } else if (arg === "--expected-head" || arg === "--review-label") {
      const value = takeFlagValue(arg, args[++i]);
      if (value === undefined) return undefined;
      if (arg === "--review-label") policy.reviewLabel = value;
      else parsed.expectedHeadSha = value;
    } else if (arg === "--method") {
      const value = takeFlagValue(arg, args[++i], gate.AUTO_MERGE_METHODS);
      if (value === undefined) return undefined;
      policy.method = value;
    } else if (arg === "--policy") {
      const value = takeFlagValue(arg, args[++i], gate.MERGE_SAFETY_POLICIES);
      if (value === undefined) return undefined;
      policy.reviewPolicy = value;
    } else if (applyTextFlag(arg, policy)) {
      // Handled.
    } else if (arg === "--review-instructions") {
      // Space form: the next token is the text. One starting with "-" is
      // ambiguous with a flag, so it must use the `=` form instead.
      const value = args[++i];
      if (!value || value.startsWith("-")) {
        console.error(
          "Error: --review-instructions requires a value (use --review-instructions=<text> for text starting with '-')",
        );
        process.exitCode = 1;
        return undefined;
      }
      policy.reviewInstructions = value;
    } else if (arg === "--rules-file") {
      const value = takeFlagValue(arg, args[++i]);
      if (value === undefined) return undefined;
      // Relative to the workspace home, never the current (repo) directory.
      policy.rulesFile = resolveRulesFilePath(value, workspaceDir);
    } else if (arg === "--no-review") {
      policy.review = false;
    } else if (arg === "--no-recheck-on-push") {
      // Worker-internal: the PR is not re-checked after new commits (status comment wording).
      policy.recheckOnPush = false;
    } else if (requirement) {
      policy[requirement] = true;
    } else if (arg === "--no-review-label") {
      policy.reviewLabel = "";
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg.startsWith("--ci-wait-posted=")) {
      // Worker-internal: the same CI wait is not re-posted to the PR.
      parsed.ciWaitPosted = arg.slice("--ci-wait-posted=".length);
    } else if (arg === "--last-attempt") {
      // Worker-internal: a failure on this attempt is stated on the PR.
      parsed.lastAttempt = true;
    } else if (arg === "-v" || arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printAutoMergeHelp(gate.DEFAULT_AUTO_MERGE_REVIEW_LABEL);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      parsed.prUrl = arg;
    }
  }
  return parsed;
}

/** `parsed`, or `undefined` (exit code set) when the custom-rules flags conflict. */
function checkCustomRulesUsage(parsed: AutoMergeCommandArgs): AutoMergeCommandArgs | undefined {
  const usageError = customRulesUsageError(parsed.policy);
  if (!usageError) return parsed;
  console.error(`Error: ${usageError}`);
  process.exitCode = 1;
  return undefined;
}

/** `--policy custom` needs exactly one rules source; rules need `--policy custom`. */
function customRulesUsageError(policy: AutoMergeCommandArgs["policy"]): string | undefined {
  const sources = [policy.rules?.trim(), policy.rulesFile].filter(Boolean).length;
  if (policy.reviewPolicy === "custom") {
    if (sources === 1) return undefined;
    return sources === 0
      ? "--policy custom requires --rules=<text> or --rules-file <path>"
      : "use only one of --rules and --rules-file";
  }
  if (policy.rules !== undefined || policy.rulesFile !== undefined) {
    return "--rules and --rules-file require --policy custom";
  }
  return undefined;
}

/**
 * `devintern auto-merge <pr-url>` — merge a PR when it passes the auto-merge
 * gates (preconditions, path policy, optional agent review). Also invoked by
 * the worker for its own PRs with the workspace's policy as flags.
 */
export async function runAutoMergeCommand(args: string[]): Promise<void> {
  const parsed = parseAutoMergeArgs(args, await import("./merge-gate"));
  if (!parsed) return;
  const { prUrl, expectedHeadSha, dryRun, lastAttempt, ciWaitPosted, verbose, policy } = parsed;

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
      policy,
      expectedHeadSha,
      dryRun,
      lastAttempt,
      ...(ciWaitPosted ? { ciWaitPosted } : {}),
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
