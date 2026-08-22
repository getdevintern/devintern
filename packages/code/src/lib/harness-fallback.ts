/**
 * Task-run-level agent harness fallback coordination.
 *
 * Given an ordered chain of resolved candidates (from
 * {@link parseHarnessChain}), this coordinator runs pipeline operations
 * (feasibility, estimation, implementation, …) against the active candidate.
 * It advances to the next candidate only for safe pre-work failures —
 * executable missing, spawn failure, recognized authentication failure, or a
 * non-zero exit before meaningful stdout — and never after meaningful agent
 * output or detected repository changes (duplicating half-finished work is
 * worse than failing once).
 *
 * Once a candidate becomes active it stays active for every later invocation
 * in the same task attempt, so review/repair spawns reuse the same harness
 * and its sandbox capabilities.
 */

import { execFileSync } from "child_process";

import type { HarnessCandidate } from "./harness-chain";
import { AgentLaunchError, isFallbackEligible, sanitizeFallbackReason } from "./harness-launch";

/** Outcome of one candidate attempt within a stage. */
export type FallbackAttemptOutcome =
  | "succeeded"
  | "executable-missing"
  | "spawn-failed"
  | "auth-failed"
  | "exited-before-output"
  | "non-fallback-error"
  | "repository-mutated";

/** Record of one attempted candidate for stage detail / summaries. */
export interface FallbackAttemptRecord {
  /** Pipeline stage that ran the candidate ("feasibility", "implementation", …). */
  stage: string;
  /** Configured value (pre-alias). */
  requested: string;
  /** Canonical registry name. */
  canonical: string;
  outcome: FallbackAttemptOutcome;
  /** Sanitized human-readable reason for failures. */
  detail?: string;
}

/**
 * Thrown when every remaining candidate failed with an eligible pre-work
 * failure. Carries an aggregated, sanitized summary instead of leaking any
 * single provider's transcript.
 */
export class ChainExhaustedError extends Error {
  readonly attempts: FallbackAttemptRecord[];

  constructor(attempts: FallbackAttemptRecord[]) {
    super(
      `All configured agent harnesses failed: ` +
        summarizeAttempts(attempts) +
        `. Check AGENT_HARNESS candidates are installed and authenticated.`,
    );
    this.name = "ChainExhaustedError";
    this.attempts = attempts;
  }
}

/** Aggregated sanitized "harness: reason" list for error messages. */
export function summarizeAttempts(attempts: FallbackAttemptRecord[]): string {
  return attempts
    .filter((attempt) => attempt.outcome !== "succeeded")
    .map(
      (attempt) => `${attempt.canonical}: ${attempt.detail ?? attempt.outcome.replace(/-/g, " ")}`,
    )
    .join("; ");
}

/** Options accepted by {@link HarnessFallbackCoordinator}. */
export interface FallbackCoordinatorOptions {
  /** Working directory for repository-state checks. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Snapshot the working-tree state so a failed attempt that mutated files
   * blocks fallback. Return `null` when state cannot be determined (fail-safe).
   */
  snapshotRepoState?: (cwd: string) => string | null;
}

/**
 * Default repository-state snapshot: `git status --porcelain`, or `null` when
 * git is unavailable / not a repository (treated as "cannot rule out work").
 */
export function defaultSnapshotRepoState(cwd: string): string | null {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
  } catch {
    return null;
  }
}

/**
 * Coordinate ordered harness candidates across one task attempt.
 */
export class HarnessFallbackCoordinator {
  private readonly candidates: HarnessCandidate[];
  private readonly cwd: string;
  private readonly snapshotRepoState: (cwd: string) => string | null;
  private readonly attempts: FallbackAttemptRecord[] = [];
  /** Candidates already disqualified by an eligible pre-work failure. */
  private readonly exhaustedCanonical = new Set<string>();
  private activePosition = 0;

  constructor(candidates: HarnessCandidate[], options: FallbackCoordinatorOptions = {}) {
    if (candidates.length === 0) {
      throw new Error("HarnessFallbackCoordinator requires at least one candidate");
    }
    this.candidates = candidates;
    this.cwd = options.cwd ?? process.cwd();
    this.snapshotRepoState = options.snapshotRepoState ?? defaultSnapshotRepoState;
  }

  /** The candidate all current and future invocations will use. */
  get active(): HarnessCandidate {
    return this.candidates[this.activePosition];
  }

  /** Canonical name of the active harness (for run-record attribution). */
  get activeHarnessName(): string {
    return this.active.entry.canonical;
  }

  /** True when at least one fallback transition happened. */
  get switched(): boolean {
    return this.activePosition > 0;
  }

  /** Every recorded attempt, in order. */
  get attemptLog(): readonly FallbackAttemptRecord[] {
    return this.attempts;
  }

  /**
   * Structured detail for run-recorder stage rows: attempted candidates,
   * failure classifications, and the selected fallback. Bounded and free of
   * transcripts or credentials.
   */
  stageDetail(): Record<string, unknown> {
    return {
      configured: this.candidates.map((c) => c.entry.raw),
      attempts: this.attempts.map((a) => ({
        stage: a.stage,
        harness: a.canonical,
        outcome: a.outcome,
        ...(a.detail ? { reason: a.detail } : {}),
      })),
      selected: this.activeHarnessName,
      fallbackUsed: this.switched,
    };
  }

  /**
   * Provenance note for tracker comments, or `null` when no fallback
   * occurred.
   */
  provenanceNote(): string | null {
    if (!this.switched) {
      return null;
    }
    const superseded = this.candidates
      .slice(0, this.activePosition)
      .map((c) => c.entry.canonical)
      .join(", ");
    return (
      `_Note: configured primary harness "${superseded}" was unavailable, so this ` +
      `run was performed with "${this.activeHarnessName}" (AGENT_HARNESS fallback)._`
    );
  }

  /**
   * Run `operation` against the first usable candidate.
   *
   * Advances through the chain only for fallback-eligible launch failures
   * while the working tree is unchanged since the operation started. Any other
   * error propagates unchanged. When every remaining candidate fails with an
   * eligible failure, throws {@link ChainExhaustedError} with an aggregated
   * summary.
   *
   * @param stage - Stage label used in messages and records.
   * @param operation - Receives the candidate to run with.
   */
  async run<T>(stage: string, operation: (candidate: HarnessCandidate) => Promise<T>): Promise<T> {
    const baseline = this.snapshotRepoState(this.cwd);

    for (;;) {
      const candidate = this.active;

      if (this.exhaustedCanonical.has(candidate.entry.canonical)) {
        throw new ChainExhaustedError(this.failedAttempts());
      }

      try {
        const result = await operation(candidate);
        this.attempts.push({
          stage,
          requested: candidate.entry.raw,
          canonical: candidate.entry.canonical,
          outcome: "succeeded",
        });
        return result;
      } catch (error) {
        // Account-global usage limits defer the whole run; they must never
        // silently start another harness under the same account.
        if (error instanceof Error && error.name === "UsageLimitError") {
          throw error;
        }

        if (!(error instanceof AgentLaunchError) || !isFallbackEligible(error.classification)) {
          this.attempts.push({
            stage,
            requested: candidate.entry.raw,
            canonical: candidate.entry.canonical,
            outcome: "non-fallback-error",
            detail: sanitizeFallbackReason(error instanceof Error ? error.message : String(error)),
          });
          throw error;
        }

        // A failed attempt may still have touched the working tree even
        // without useful stdout. Fail safely rather than duplicate work.
        const current = this.snapshotRepoState(this.cwd);
        if (baseline !== null && current !== baseline) {
          this.attempts.push({
            stage,
            requested: candidate.entry.raw,
            canonical: candidate.entry.canonical,
            outcome: "repository-mutated",
            detail: "working tree changed during the failed attempt",
          });
          throw new Error(
            `${candidate.resolved.harness.displayName} failed after modifying the working tree; ` +
              `not falling back to avoid duplicating changes. Inspect the workspace and re-run.`,
          );
        }
        if (current === null && baseline === null) {
          // Cannot rule out prior work (no git): fail safely too.
          this.attempts.push({
            stage,
            requested: candidate.entry.raw,
            canonical: candidate.entry.canonical,
            outcome: "repository-mutated",
            detail: "repository state could not be verified",
          });
          throw new Error(
            `${candidate.resolved.harness.displayName} failed and repository state could not be ` +
              `verified; not falling back to avoid duplicating possible changes.`,
          );
        }

        this.exhaustedCanonical.add(candidate.entry.canonical);
        this.attempts.push({
          stage,
          requested: candidate.entry.raw,
          canonical: candidate.entry.canonical,
          outcome: error.classification,
          detail: sanitizeFallbackReason(error.message),
        });

        const nextCandidate = this.candidates[this.activePosition + 1];
        console.log(
          `\n🔁 ${candidate.resolved.harness.displayName} could not start (${error.classification}): ` +
            `${sanitizeFallbackReason(error.message)}`,
        );
        if (!nextCandidate) {
          throw new ChainExhaustedError(this.failedAttempts());
        }
        this.activePosition += 1;
        console.log(
          `🔁 Falling back to ${nextCandidate.resolved.harness.displayName} ` +
            `(candidate ${nextCandidate.position + 1}/${this.candidates.length} of AGENT_HARNESS)...`,
        );
      }
    }
  }

  /** Failure records, deduplicated by canonical harness (first occurrence). */
  private failedAttempts(): FallbackAttemptRecord[] {
    const seen = new Set<string>();
    const unique: FallbackAttemptRecord[] = [];
    for (const attempt of this.attempts) {
      if (attempt.outcome === "succeeded" || seen.has(attempt.canonical)) {
        continue;
      }
      seen.add(attempt.canonical);
      unique.push(attempt);
    }
    return unique;
  }
}
