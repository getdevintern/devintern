import { describe, expect, test } from "bun:test";

import { parseEstimationEntries } from "../src/lib/estimation-config";

function firstError(value: unknown): string {
  const { errors } = parseEstimationEntries(value);
  return errors.join("\n");
}

describe("parseEstimationEntries", () => {
  test("omitted or null means estimation is off", () => {
    expect(parseEstimationEntries(undefined)).toEqual({ estimations: [], errors: [] });
    expect(parseEstimationEntries(null)).toEqual({ estimations: [], errors: [] });
  });

  test("parses cron and interval entries", () => {
    const { estimations, errors } = parseEstimationEntries([
      {
        id: "weekday-groom",
        enabled: true,
        cron: "0 9 * * 1-5",
        query: "status = 'To Do' AND labels IN (NeedsEstimate)",
      },
      {
        id: "sprint-gaps",
        enabled: false,
        interval: "6h",
        query: "sprint in openSprints()",
      },
    ]);
    expect(errors).toEqual([]);
    expect(estimations).toHaveLength(2);
    expect(estimations[0]).toMatchObject({
      id: "weekday-groom",
      enabled: true,
      cron: "0 9 * * 1-5",
    });
    expect(estimations[1]).toMatchObject({
      id: "sprint-gaps",
      enabled: false,
      intervalMs: 21_600_000,
    });
  });

  test("requires a non-empty query", () => {
    const error = firstError([{ id: "a", enabled: true, cron: "0 9 * * 1-5" }]);
    expect(error).toContain("[[estimations]][0].query is required.");
    expect(firstError([{ id: "a", enabled: true, cron: "0 9 * * 1-5", query: "   " }])).toContain(
      "[[estimations]][0].query must be a non-empty string.",
    );
  });

  test("rejects prompt and repo — estimation is not an implement job", () => {
    const error = firstError([
      {
        id: "a",
        enabled: true,
        cron: "0 9 * * 1-5",
        query: "q",
        prompt: "implement this",
        repo: "backend",
      },
    ]);
    expect(error).toContain("[[estimations]][0].prompt is not supported.");
    expect(error).toContain("[[estimations]][0].repo is not supported.");
  });

  test("rejects kind — there is no estimate flavor of automations", () => {
    const error = firstError([
      { id: "a", enabled: true, cron: "0 9 * * 1-5", query: "q", kind: "estimate" },
    ]);
    expect(error).toContain("[[estimations]][0].kind is not supported.");
  });

  test("rejects duplicate ids and invalid ids", () => {
    const error = firstError([
      { id: "dup", enabled: true, cron: "0 9 * * 1-5", query: "q" },
      { id: "dup", enabled: true, cron: "0 10 * * 1-5", query: "q" },
    ]);
    expect(error).toContain('Duplicate estimation id "dup"');
    expect(firstError([{ id: "", enabled: true, cron: "0 9 * * 1-5", query: "q" }])).toContain(
      "[[estimations]][0].id is required.",
    );
    expect(
      firstError([{ id: "has space", enabled: true, cron: "0 9 * * 1-5", query: "q" }]),
    ).toContain("[[estimations]][0].id must contain only letters");
  });

  test.each([
    [
      "enabled missing",
      { id: "a", cron: "0 9 * * 1-5", query: "q" },
      ".enabled must be a boolean.",
    ],
    [
      "neither cron nor interval",
      { id: "a", enabled: true, query: "q" },
      "must set exactly one of cron or interval.",
    ],
    [
      "both cron and interval",
      { id: "a", enabled: true, cron: "0 9 * * 1-5", interval: "6h", query: "q" },
      "must set exactly one of cron or interval.",
    ],
  ])("%s", (_label, entry, expected) => {
    expect(firstError([entry])).toContain(expected);
  });

  test("validates the schedule grammar like [[automations]]", () => {
    expect(firstError([{ id: "a", enabled: true, cron: "daily noon", query: "q" }])).toContain(
      "[[estimations]][0].cron must be a five-field cron expression.",
    );
    expect(firstError([{ id: "a", enabled: true, cron: "99 99 * * *", query: "q" }])).toContain(
      "[[estimations]][0].cron is invalid:",
    );
    expect(firstError([{ id: "a", enabled: true, interval: "45x", query: "q" }])).toContain(
      "[[estimations]][0].interval must use a positive duration such as 15m, 6h, or 1d.",
    );
  });

  test("reports malformed table shapes", () => {
    expect(firstError("nope")).toContain("[[estimations]] must be an array of tables.");
    expect(firstError(["nope"])).toContain("[[estimations]][0] must be a table.");
  });
});
