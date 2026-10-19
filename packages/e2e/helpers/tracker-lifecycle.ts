import { expect } from "bun:test";
import type { PullRequest } from "../providers/github";
import type { TrackerComment, TrackerTicketState } from "../providers/tracker";
import type { TrackerScenario, TrackerStatusSettings } from "./tracker-scenario";

/** Identifying header of the automated implementation-success comment. */
export const IMPLEMENTATION_COMMENT_MARKER = "Implementation Completed by @devintern/code";

/**
 * Keep only the pull requests created by a scenario's own run.
 *
 * The code host is shared across scenarios, so a branch query can return a
 * foreign run's PR whose head happens to reuse a deterministic tracker key (a
 * fresh GitLab project always yields decoy iid 1, hence `feature/1`). Every PR
 * a run creates targets that scenario's unique `base` ref, so filtering on it
 * isolates this run's work and tolerates a foreign ref sharing the same head
 * instead of requiring the branch to be globally absent.
 */
export function pullsCreatedByRun(pulls: PullRequest[], base: string): PullRequest[] {
  return pulls.filter((pull) => pull.base.ref === base);
}

/**
 * Provider-agnostic assertions for a successful remote tracker lifecycle.
 *
 * Both the GitHub Issues and local GitLab Issues scenarios run the same code
 * host (GitHub) and the same deterministic agent. Provider differences are
 * confined to each {@link TrackerFixture} — most visibly `openState` (`open`
 * for GitHub, `opened` for GitLab) — so one assertion body covers both without
 * hardcoding either provider's semantics.
 *
 * Every tracker read below goes back through the provider API rather than the
 * CLI's stdout, so a passing run reflects durable tracker state.
 */
export async function assertTrackerLifecycle(scenario: TrackerScenario): Promise<void> {
  const key = scenario.requireTicketKey();
  const statuses = scenario.statuses;

  // 1. PR metadata: the code host identifies the source ticket.
  // Scope to this run's unique base so a foreign-run PR that reuses the
  // deterministic head ref is not mistaken for a duplicate of our own PR.
  const pull = await scenario.github.waitForPull(scenario.head, scenario.base);
  expect(pull.state).toBe("open");
  expect(pull.head.ref).toBe(scenario.head);
  expect(pull.base.ref).toBe(scenario.base);
  expect(pull.title).toBe(`[${key}] ${scenario.title}`);
  expect(pull.body).toContain(`Task ${key}:`);
  expect(pull.body).toContain("Hello, world!");

  // 2. The remote commit changes only the canonical greeting file.
  const files = await scenario.github.request<Array<{ filename: string }>>(
    `/pulls/${pull.number}/files`,
  );
  expect(files.map((file) => file.filename)).toEqual(["src/greeting.ts"]);
  expect(await scenario.git("diff", "--name-only", `${scenario.base}...HEAD`)).toBe(
    "src/greeting.ts",
  );

  // 3. The recorded run is attributed to the real tracker and task key.
  // Inspect every run, including any accidentally selected decoy.
  const records = scenario.runRecords({ allTasks: true });
  expect(records).toHaveLength(1);
  expect(records[0].status).toBe("succeeded");
  expect(records[0].tracker).toBe(scenario.tracker.type);
  expect(records[0].task_key).toBe(key);
  expect(records[0].pr_url).toBeTruthy();

  // 4. Status transition: final status present, obsolete status labels removed,
  //    unrelated label preserved.
  const ticket = await scenario.getTicket(key);
  assertTicketState({
    ticket,
    openState: scenario.tracker.openState,
    descriptionMarker: scenario.descriptionMarker,
    statuses,
    seedLabels: scenario.seedLabels,
  });

  // 5. The implementation summary comment is read back from the tracker.
  const comments = await scenario.listComments(key);
  assertImplementationComment(comments);
  // The seeded comment remains until cleanup removes it.
  expect(comments.some((comment) => comment.body.includes(scenario.commentMarker))).toBe(true);

  // 6. Provider-native selector: only the expected ticket matches, and the
  //    decoy outside the selector is untouched.
  const selected = await scenario.waitForSelectedTickets();
  expect(selected.map((ticket) => ticket.key)).toEqual([key]);

  const decoy = scenario.decoyTicket;
  expect(decoy).toBeDefined();
  if (decoy) {
    expect(selected.map((ticket) => ticket.key)).not.toContain(decoy.key);
    const decoyState = await scenario.getTicket(decoy.key);
    expect(decoyState.state).toBe(scenario.tracker.openState);
    expect(decoyState.body).toContain(scenario.decoyMarker);
    expect(decoyState.body).not.toContain(scenario.descriptionMarker);
    expect(decoyState.labels).toEqual([]);
    expect(await scenario.listComments(decoy.key)).toEqual([]);
    // Scope the decoy PR check to this run: a foreign run on the shared code
    // host can hold a `feature/<decoy-key>` PR (deterministic keys), but only a
    // PR this run created targets this scenario's unique base ref.
    const decoyPulls = await scenario.github.pulls(`feature/${decoy.key.toLowerCase()}`);
    expect(pullsCreatedByRun(decoyPulls, scenario.base)).toEqual([]);
  }
}

/**
 * Assert a read-back ticket is still active with the expected labels.
 *
 * `openState` is the provider-native active state supplied by the fixture, so
 * the same check works for GitHub (`open`) and GitLab (`opened`). Keeping this
 * as a standalone function lets the offline suite exercise provider-native
 * values without a live tracker.
 */
export function assertTicketState(input: {
  ticket: TrackerTicketState;
  openState: string;
  descriptionMarker: string;
  statuses: Required<TrackerStatusSettings>;
  seedLabels: string[];
}): void {
  expect(input.ticket.state).toBe(input.openState);
  expect(input.ticket.body).toContain(input.descriptionMarker);
  expect(input.ticket.labels).toContain(input.statuses.prStatus);
  expect(input.ticket.labels).not.toContain(input.statuses.todoStatus);
  expect(input.ticket.labels).not.toContain(input.statuses.inProgressStatus);
  for (const label of input.seedLabels) expect(input.ticket.labels).toContain(label);
}

/**
 * Assert the implementation summary is readable back from the tracker.
 *
 * The CLI posts `extractImplementationSummary(...)`, which strips the
 * `<!-- devintern:summary:... -->` delimiters, so the durable content the
 * tracker stores is the formatter header plus the briefing headings and body.
 * Asserting on those (never the raw delimiter) is what makes the check pass for
 * every provider.
 */
export function assertImplementationComment(comments: TrackerComment[]): void {
  const implementation = comments.find((comment) =>
    comment.body.includes(IMPLEMENTATION_COMMENT_MARKER),
  );
  expect(implementation).toBeDefined();
  expect(implementation?.body).toContain("## What changed");
  expect(implementation?.body).toContain("Updated src/greeting.ts");
}
