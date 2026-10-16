import { expect } from "bun:test";
import type { TrackerScenario } from "./tracker-scenario";

/**
 * Provider-agnostic assertions for a successful remote tracker lifecycle.
 *
 * Both the GitHub Issues and local GitLab Issues scenarios run the same code
 * host (GitHub) and the same deterministic agent, so the only difference is
 * the injected {@link TrackerScenario.tracker}. Keeping one assertion body
 * means the acceptance criteria cannot silently drift between providers.
 *
 * Every tracker read below goes back through the provider API rather than the
 * CLI's stdout, so a passing run reflects durable tracker state.
 */
export async function assertTrackerLifecycle(scenario: TrackerScenario): Promise<void> {
  const key = scenario.requireTicketKey();
  const statuses = scenario.statuses;

  // 1. PR metadata: the code host identifies the source ticket.
  const pull = await scenario.github.waitForPull(scenario.head);
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
  const records = scenario.runRecords();
  expect(records).toHaveLength(1);
  expect(records[0].status).toBe("succeeded");
  expect(records[0].tracker).toBe(scenario.tracker.type);
  expect(records[0].task_key).toBe(key);
  expect(records[0].pr_url).toBeTruthy();

  // 4. Status transition: final status present, obsolete status labels removed,
  //    unrelated label preserved.
  const ticket = await scenario.getTicket(key);
  expect(ticket.state).toBe("open");
  expect(ticket.body).toContain(scenario.descriptionMarker);
  expect(ticket.labels).toContain(statuses.prStatus);
  expect(ticket.labels).not.toContain(statuses.todoStatus);
  expect(ticket.labels).not.toContain(statuses.inProgressStatus);
  for (const label of scenario.seedLabels) expect(ticket.labels).toContain(label);

  // 5. The implementation summary comment is read back from the tracker.
  const comments = await scenario.listComments(key);
  expect(
    comments.some((comment) => comment.body.includes("<!-- devintern:summary:start -->")),
  ).toBe(true);
  expect(comments.some((comment) => comment.body.includes("Updated src/greeting.ts"))).toBe(true);
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
    expect(decoyState.state).toBe("open");
    expect(decoyState.body).toContain(scenario.decoyMarker);
    expect(decoyState.body).not.toContain(scenario.descriptionMarker);
    expect(await scenario.github.pulls(`feature/${decoy.key.toLowerCase()}`)).toEqual([]);
  }
}
