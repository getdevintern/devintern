import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AutomationsTable } from "@/components/workspace/WorkspaceSections";
import type { WorkspaceAutomationView } from "@/lib/api";

function automation(overrides: Partial<WorkspaceAutomationView> = {}): WorkspaceAutomationView {
  return {
    id: "nightly",
    enabled: true,
    cron: "0 3 * * *",
    repo: "devintern",
    openPr: false,
    allowNoChanges: false,
    prompt: "Do the thing.",
    ...overrides,
  };
}

function render(automations: WorkspaceAutomationView[]): string {
  return renderToStaticMarkup(createElement(AutomationsTable, { automations }));
}

test("workspace automations group by repo, one header per repo, even a single one", () => {
  const single = render([automation({ id: "a" }), automation({ id: "b" })]);
  expect(single.split('scope="rowgroup"').length - 1).toBe(1);
  expect(single).toContain(">devintern<");
  expect(single).not.toContain(">Repository<");

  const mixed = render([
    automation({ id: "web-job", repo: "web" }),
    automation({ id: "loose", repo: undefined }),
    automation({ id: "api-job", repo: "api" }),
  ]);
  expect(mixed.split("<tbody").length - 1).toBe(3);
  const order = ["General", "api", "web"].map((label) => mixed.indexOf(`>${label}<`));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("all-general workspace automations render flat", () => {
  const html = render([automation({ repo: undefined })]);
  expect(html).not.toContain('scope="rowgroup"');
  expect(html).not.toContain(">General<");
});
