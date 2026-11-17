import { expect, test } from "bun:test";

import { parseHash, redirectHash, RUNS_HASH, runHash } from "@/lib/routes";

test("the landing hash is the overview", () => {
  expect(parseHash("")).toEqual({ view: "overview" });
  expect(parseHash("#/")).toEqual({ view: "overview" });
  expect(parseHash("#/no-such-page")).toEqual({ view: "overview" });
});

test("the runs list moved to #/runs and run detail still parses", () => {
  expect(parseHash(RUNS_HASH)).toEqual({ view: "runs" });
  expect(parseHash(runHash(42))).toEqual({ view: "run", id: 42 });
  expect(parseHash("#/runs/abc")).toEqual({ view: "overview" });
});

test("workspace and the existing sections parse", () => {
  expect(parseHash("#/workspace")).toEqual({ view: "workspace" });
  expect(parseHash("#/automations")).toEqual({ view: "automations" });
  expect(parseHash("#/automations/needs%20space")).toEqual({
    view: "automation",
    id: "needs space",
  });
  expect(parseHash("#/automations/%E0%A4%A")).toEqual({ view: "automations" });
  expect(parseHash("#/prs")).toEqual({ view: "prs" });
  expect(parseHash("#/stats")).toEqual({ view: "stats" });
  expect(parseHash("#/logs")).toEqual({ view: "logs" });
});

test("the retired task activity page redirects to the overview", () => {
  expect(redirectHash("#/activity")).toBe("#/");
  expect(parseHash("#/activity")).toEqual({ view: "overview" });
  for (const current of ["", "#/", RUNS_HASH, runHash(7), "#/automations", "#/logs"]) {
    expect(redirectHash(current)).toBeNull();
  }
});
