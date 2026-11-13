import { expect, test } from "bun:test";

import { groupAutomationsByRepo } from "@/lib/automation-groups";
import type { AutomationSchedule } from "@/lib/api";

function automation(id: string, overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return { id, enabled: true, prompt: "Do the thing.", ...overrides };
}

function shape(automations: AutomationSchedule[]): Array<[string | undefined, string[]]> {
  return groupAutomationsByRepo(automations).map((group) => [
    group.repo,
    group.automations.map((item) => item.id),
  ]);
}

test("general automations come first, then repos sorted by name", () => {
  expect(
    shape([
      automation("zeta", { repo: "web" }),
      automation("alpha", { repo: "api" }),
      automation("loose"),
      automation("beta", { repo: "Billing" }),
    ]),
  ).toEqual([
    [undefined, ["loose"]],
    ["api", ["alpha"]],
    ["Billing", ["beta"]],
    ["web", ["zeta"]],
  ]);
});

test("a blank repo counts as general", () => {
  const groups = groupAutomationsByRepo([automation("a", { repo: "  " }), automation("b")]);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.key).toBe("general");
});

test("all-general and single-repo workspaces produce one group", () => {
  expect(shape([automation("a"), automation("b")])).toEqual([[undefined, ["a", "b"]]]);
  expect(
    shape([automation("a", { repo: "devintern" }), automation("b", { repo: "devintern" })]),
  ).toEqual([["devintern", ["a", "b"]]]);
  expect(groupAutomationsByRepo([])).toEqual([]);
});

test("within a group, enabled come before disabled, then by next due time", () => {
  expect(
    shape([
      automation("off-soon", { enabled: false, nextDueAt: 1 }),
      automation("unscheduled"),
      automation("later", { nextDueAt: 300 }),
      automation("soon", { nextDueAt: 100 }),
      automation("off-unscheduled", { enabled: false }),
    ]),
  ).toEqual([[undefined, ["soon", "later", "unscheduled", "off-soon", "off-unscheduled"]]]);
});

test("does not mutate the input order", () => {
  const input = [automation("b", { nextDueAt: 2 }), automation("a", { nextDueAt: 1 })];
  groupAutomationsByRepo(input);
  expect(input.map((item) => item.id)).toEqual(["b", "a"]);
});
