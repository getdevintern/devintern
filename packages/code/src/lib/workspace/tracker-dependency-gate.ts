/**
 * Dependency gate for polled tracker tickets with blockers: native ones (Jira
 * "is blocked by" links, Linear `blocks` relations, GitHub issue
 * dependencies, GitLab blocking links, Azure DevOps predecessors, Asana
 * dependencies) or a `Depends on:` description line (Trello, markdown).
 *
 * The fleet executor calls the gate after routing and before it touches git
 * or starts the task subprocess, so a held-back ticket is never transitioned
 * or commented on. The verdict is persisted in `tracker_dependencies` (shown
 * by `worker queue` and the dashboard) and the poller re-evaluates the ticket
 * on its next tick.
 *
 * Blockers resolve through {@link trackerBlockerFacts}: blockers this worker
 * implemented follow the same merged/stacked rules as ad-hoc dependencies;
 * others count once the tracker reports them done.
 */

import { evaluateDependencyGate } from "../dependencies/gate";
import type {
  DependencyFacts,
  DependencyGateDecision,
  DependencyMode,
  MergeStateAnswer,
  StackBase,
} from "../dependencies/gate";
import { readLocalDependencyFacts } from "../dependencies/local-facts";
import { trackerBlockerFacts } from "../dependencies/tracker-facts";
import { TrackerDependencyStore } from "../state/tracker-dependencies";
import { supportsDependencies } from "../trackers/capabilities";
import type { TaskBlocker, TaskTrackerClient } from "../trackers/client";
import type { WorkerState } from "../state/worker-state";
import { findTeam } from "./config";
import type { WorkspaceConfig } from "./config";
import { createDependencyMergeStateResolver } from "./fleet-event-acquirers";
import type { UnknownMergeStateLookup } from "./injected-acquirer";
import { MERGE_STATE_LOOKUP_COOLDOWN_MS, MERGE_STATE_LOOKUP_TIMEOUT_MS } from "./injected-acquirer";

/**
 * The gate's answer for one ticket. A stacked verdict's base is passed to the
 * task subprocess, which records the ticket's `stacked_on` only once its
 * pipeline actually targets that base.
 */
export type TrackerGateOutcome =
  | { kind: "ready"; stackedOn?: StackBase }
  | { kind: "waiting" | "blocked"; reason: string };

/** Gate one routed ticket: `(taskKey, repo)` → outcome. */
export type TrackerDependencyGate = ((
  taskKey: string,
  repo: string,
) => Promise<TrackerGateOutcome>) & {
  /** Clear waits of tickets the poll search no longer returns. */
  clearStaleWaits?: (polledKeys: ReadonlySet<string>) => void;
};

export interface TrackerDependencyGateOptions {
  /** Workspace DB (`state/queue.db`): runs, PR registry, gate state. */
  dbPath: string;
  /** Tracker type of the polled source (`jira`, `linear`, `github`, …). */
  tracker: string;
  /** Team of the polled source (multi-team workspaces). */
  team?: string;
  /** The tracker's native blockers for a ticket. */
  getBlockers: (taskKey: string) => Promise<TaskBlocker[]>;
  /** Mode for this source, read per evaluation so config reloads apply. */
  mode: () => DependencyMode;
  /**
   * Ask the code host whether a blocker's PR merged (see
   * `InjectedTaskAcquirerOptions.resolveMergeState`); without it, the gate
   * relies on the PR registry alone.
   */
  resolveMergeState?: (lookup: UnknownMergeStateLookup) => Promise<MergeStateAnswer | null>;
  /** Per-lookup timeout (defaults to {@link MERGE_STATE_LOOKUP_TIMEOUT_MS}). */
  lookupTimeoutMs?: number;
  /** Log prefix (`[fleet:platform]`). */
  scope?: string;
  now?: () => number;
}

/** Trackers whose task keys are unique only within one team's source. */
const TEAM_SCOPED_KEY_TRACKERS = new Set(["github", "gitlab", "markdown"]);

/** Prefix of generated ad-hoc task keys (`worker add`), unique per workspace. */
const AD_HOC_KEY_PREFIX = "local-";

/** A blocker the tracker could not find: reported with no done state. */
const isUnresolvedBlocker = (blocker: TaskBlocker): boolean =>
  blocker.status === "not found" && blocker.done === undefined;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Build the gate for one polled tracker source. */
export function createTrackerDependencyGate(
  options: TrackerDependencyGateOptions,
): TrackerDependencyGate {
  const now = options.now ?? Date.now;
  const scope = options.scope ?? "[fleet]";
  const lastLookup = new Map<string, number>();
  /** Final PR states the code host reported, per `repo#number`. */
  const observed = new Map<string, MergeStateAnswer>();
  /** One connection per gate, opened on first use (not per evaluation). */
  let store: TrackerDependencyStore | undefined;
  const openStore = (): TrackerDependencyStore =>
    (store ??= new TrackerDependencyStore(options.dbPath));

  const overlay = (facts: DependencyFacts, fallbackRepo: string): DependencyFacts => {
    const repo = facts.latestRun?.repo ?? fallbackRepo;
    const withBase = facts.stackBase
      ? { ...facts, stackBase: overlay(facts.stackBase, repo) }
      : facts;
    const number = withBase.pr?.number ?? withBase.latestRun?.prNumber;
    if (number === undefined) return withBase;
    const answer = observed.get(`${repo}#${number}`);
    if (!answer) return withBase;
    // The registry wins once it has a settled row; a re-run supersedes a
    // `closed` answer (the PR may be reopened).
    if (withBase.pr && withBase.pr.state !== "open" && withBase.pr.state !== "closed-unknown") {
      return withBase;
    }
    if (answer.state === "closed" && withBase.latestRun?.status === "in_progress") return withBase;
    return {
      ...withBase,
      pr: {
        number,
        url: withBase.pr?.url ?? withBase.latestRun?.prUrl,
        branch: withBase.pr?.branch ?? withBase.latestRun?.branch,
        state: answer.state,
        ...(answer.state === "merged"
          ? {
              mergedAt: answer.mergedAt ?? withBase.pr?.mergedAt,
              mergedInto: answer.mergedInto ?? withBase.pr?.mergedInto,
              mergedIntoDefault: answer.mergedIntoDefault ?? withBase.pr?.mergedIntoDefault,
            }
          : {}),
      },
    };
  };

  /** Ask the code host about the PRs a waiting decision names; true when any answered. */
  const lookUp = async (
    decision: Extract<DependencyGateDecision, { kind: "waiting" }>,
    facts: readonly DependencyFacts[],
    repo: string,
  ): Promise<boolean> => {
    const resolve = options.resolveMergeState;
    if (!resolve) return false;
    const answers = await Promise.all(
      decision.mergeStateLookups.map(async ({ key, pr }) => {
        const lookupRepo = facts.find((entry) => entry.key === key)?.latestRun?.repo ?? repo;
        const lookupKey = `${lookupRepo}#${pr.number}`;
        const last = lastLookup.get(lookupKey);
        if (last !== undefined && now() - last < MERGE_STATE_LOOKUP_COOLDOWN_MS) return false;
        lastLookup.set(lookupKey, now());
        try {
          const answer = await withTimeout(
            resolve({ repo: lookupRepo, taskKey: key, pr }),
            options.lookupTimeoutMs ?? MERGE_STATE_LOOKUP_TIMEOUT_MS,
          );
          if (!answer) return false;
          observed.set(lookupKey, answer);
          return true;
        } catch (error) {
          console.warn(
            `⚠️  ${scope} could not check whether ${key} PR #${pr.number} merged: ` +
              `${(error as Error).message}`,
          );
          return false;
        }
      }),
    );
    return answers.some(Boolean);
  };

  // GitHub and GitLab issues are keyed by their bare number, and markdown
  // tasks by their file name, unique only within the team's repository,
  // project, or tasks folder: another team's `12` is a different ticket, so
  // only this team's runs count as handling a blocker locally. Jira, Linear,
  // Azure DevOps, Asana, and Trello keys are workspace-wide, so a blocker
  // another team implemented still counts.
  const localScope =
    TEAM_SCOPED_KEY_TRACKERS.has(options.tracker) && options.team !== undefined
      ? { team: options.team }
      : undefined;

  /**
   * Read local facts for the blockers. Ad-hoc `local-…` keys are generated
   * unique per workspace (see deriveInjectedTaskKey) and their runs usually
   * carry no team, so they are always read unscoped (which also consults
   * `injected_tasks`). So is a key this tracker cannot find (`not found`, no
   * done state): it is not one of this team's own tickets, but may be another
   * tracker's key (a markdown ticket naming `PROJ-12`) whose only runs belong
   * to the team that owns it. Only keys this tracker resolved are team-scoped.
   */
  const readLocalFacts = (
    db: Parameters<typeof readLocalDependencyFacts>[0],
    keys: string[],
    unresolved: ReadonlySet<string>,
  ) => {
    if (!localScope) return readLocalDependencyFacts(db, keys, undefined);
    const unscoped = keys.filter((key) => key.startsWith(AD_HOC_KEY_PREFIX) || unresolved.has(key));
    const scoped = keys.filter((key) => !unscoped.includes(key));
    return [
      ...readLocalDependencyFacts(db, unscoped, undefined),
      ...readLocalDependencyFacts(db, scoped, localScope),
    ];
  };

  const evaluateTicket = async (taskKey: string, repo: string): Promise<TrackerGateOutcome> => {
    let blockers: TaskBlocker[];
    let readError: string | undefined;
    try {
      blockers = (await options.getBlockers(taskKey)).filter((blocker) => blocker.key !== taskKey);
    } catch (error) {
      // Fail closed: starting out of order is worse than one more poll.
      blockers = [];
      readError = `could not read ${taskKey}'s blockers from ${options.tracker}: ${(error as Error).message}`;
    }

    const store = openStore();
    const keys = [...new Set(blockers.map((blocker) => blocker.key))];
    const verdictBase = {
      taskKey,
      team: options.team,
      tracker: options.tracker,
      repo,
      dependsOn: keys,
      dependencyMode: options.mode(),
    };
    if (readError) {
      if (store.record({ ...verdictBase, state: "waiting", reason: readError }, now())) {
        console.warn(`⚠️  ${scope} ${taskKey} waiting: ${readError}`);
      }
      return { kind: "waiting", reason: readError };
    }
    if (keys.length === 0) {
      // `stacked_on` is kept: an earlier stacked run's PR may still target
      // that base (see TrackerDependencyStore.clear).
      store.clear(taskKey, options.team);
      return { kind: "ready" };
    }

    const unresolved = new Set(blockers.filter(isUnresolvedBlocker).map((blocker) => blocker.key));
    const evaluate = (): { decision: DependencyGateDecision; facts: DependencyFacts[] } => {
      const facts = trackerBlockerFacts(
        blockers,
        readLocalFacts(store.connection(), keys, unresolved),
      ).map((entry) => overlay(entry, repo));
      return { decision: evaluateDependencyGate(verdictBase.dependencyMode, facts), facts };
    };
    let { decision, facts } = evaluate();
    if (decision.kind === "waiting" && decision.mergeStateLookups.length > 0) {
      if (await lookUp(decision, facts, repo)) ({ decision, facts } = evaluate());
    }

    let outcome: TrackerGateOutcome =
      decision.kind === "ready"
        ? { kind: "ready", ...(decision.stackedOn ? { stackedOn: decision.stackedOn } : {}) }
        : { kind: decision.kind, reason: decision.reason };
    if (outcome.kind === "ready" && outcome.stackedOn) {
      // A branch can only be stacked on within one repository.
      const base = outcome.stackedOn;
      const baseRepo = facts.find((entry) => entry.key === base.taskKey)?.latestRun?.repo;
      if (baseRepo !== undefined && baseRepo !== repo) {
        // Unstackable, so every blocker must merge: evaluate in merged mode,
        // which also asks the code host about the base's possibly stale
        // `open` PR row (same cooldown as any other lookup).
        let merged = evaluateDependencyGate("merged", facts);
        if (merged.kind === "waiting" && merged.mergeStateLookups.length > 0) {
          if (await lookUp(merged, facts, repo)) {
            ({ facts } = evaluate());
            merged = evaluateDependencyGate("merged", facts);
          }
        }
        outcome =
          merged.kind === "ready"
            ? { kind: "ready" }
            : merged.kind === "blocked"
              ? { kind: "blocked", reason: merged.reason }
              : {
                  kind: "waiting",
                  reason:
                    `${base.taskKey} PR #${base.prNumber} not merged (it is in repo ${baseRepo}, ` +
                    `not ${repo}, so it cannot be stacked on)`,
                };
      }
    }

    const changed = store.record(
      {
        ...verdictBase,
        state: outcome.kind === "ready" ? null : outcome.kind,
        reason: outcome.kind === "ready" ? null : outcome.reason,
      },
      now(),
    );
    if (outcome.kind === "ready") {
      // `stacked_on` is recorded by the task subprocess once its pipeline
      // confirms the stack (see recordTrackerStackedOn): an explicit
      // `Target branch:` or a base missing on the remote drops it.
      if (changed) console.log(`✅ ${scope} ${taskKey} blockers satisfied (${keys.join(", ")})`);
    } else if (changed) {
      if (outcome.kind === "blocked") {
        console.warn(`⛔ ${scope} ${taskKey} blocked: ${outcome.reason}`);
      } else {
        console.log(`⏳ ${scope} ${taskKey} waiting: ${outcome.reason}`);
      }
      // A blocker the tracker cannot find (a typo, a deleted card) waits until
      // the description is edited; surface it so the stall is noticed.
      const missing = blockers.filter(isUnresolvedBlocker).map((blocker) => blocker.key);
      if (missing.length > 0) {
        console.warn(
          `⚠️  ${scope} ${taskKey} names blockers ${options.tracker} cannot find: ` +
            `${missing.join(", ")} (fix the ticket's dependencies if they are not ad-hoc tasks)`,
        );
      }
    }
    return outcome;
  };

  const gate: TrackerDependencyGate = async (taskKey, repo) => {
    try {
      return await evaluateTicket(taskKey, repo);
    } catch (error) {
      // A state DB error (locked, corrupt, schema drift) must not reject: the
      // poller has already claimed the ticket's change, and a rejected run
      // would leave it claimed until the ticket is edited again. Fail closed
      // with a "waiting" verdict (not persisted: the DB is what failed) so the
      // poller re-admits the ticket next tick; reopen the connection then.
      const reason = `could not evaluate ${taskKey}'s blockers: ${(error as Error).message}`;
      console.warn(`⚠️  ${scope} ${taskKey} waiting: ${reason}`);
      try {
        store?.close();
      } catch {
        // Already unusable; dropping the handle is enough.
      }
      store = undefined;
      return { kind: "waiting", reason };
    }
  };
  gate.clearStaleWaits = (polledKeys) => openStore().clearWaitsExcept(options.team, polledKeys);
  return gate;
}

/**
 * Native-blocker gate wiring for one polled tracker source: the gate plus the
 * poll hook that clears waits of tickets the query no longer returns. Empty
 * when the tracker does not model blockers. The mode follows
 * `[[teams]].dependency_mode`, else `[defaults].dependency_mode`, read per
 * evaluation so config reloads apply.
 */
export function trackerDependencyDeps(input: {
  config: WorkspaceConfig;
  workspaceDir: string;
  state: { dbPath: string; workerState: Pick<WorkerState, "markAgentPrClosed"> };
  tracker: string;
  teamName?: string;
  getTracker: () => TaskTrackerClient;
}): {
  dependencyGate?: TrackerDependencyGate;
  onPolledTasks?: (keys: ReadonlySet<string>) => void;
} {
  if (!supportsDependencies(input.tracker)) return {};
  const { config, teamName, state } = input;
  const dependencyGate = createTrackerDependencyGate({
    dbPath: state.dbPath,
    tracker: input.tracker,
    team: teamName,
    getBlockers: async (taskKey) => {
      const client = input.getTracker();
      return client.getBlockers ? client.getBlockers(taskKey) : [];
    },
    mode: () =>
      (teamName ? findTeam(config, teamName)?.dependencyMode : undefined) ??
      config.defaults.dependencyMode,
    resolveMergeState: createDependencyMergeStateResolver({
      config,
      workspaceDir: input.workspaceDir,
      workerState: state.workerState,
    }),
    scope: teamName ? `[fleet:${teamName}]` : "[fleet]",
  });
  return {
    dependencyGate,
    onPolledTasks: (keys) => dependencyGate.clearStaleWaits?.(keys),
  };
}
