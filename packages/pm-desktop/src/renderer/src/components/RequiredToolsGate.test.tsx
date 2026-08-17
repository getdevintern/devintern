import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RequiredToolsGate } from "./RequiredToolsGate.tsx";
import { qk } from "../queries/keys.ts";
import { createTestQueryClient, withQueryClient } from "../test-helpers/query-client.tsx";
import type { ToolValidation } from "../../../shared/tool-validation.ts";

const noop = () => {};

const missingBoth: ToolValidation = {
  ok: false,
  warnings: [],
  installedHarnesses: [],
  tools: [
    {
      id: "git",
      label: "Git",
      required: true,
      found: false,
      hint: "Install Git and make sure it is on your PATH.",
      docsUrl: "https://git-scm.com/downloads",
    },
    {
      id: "agent-harness",
      label: "Agent CLI",
      required: true,
      found: false,
      hint: "Install at least one supported agent CLI (for example Claude Code (`claude`)).",
    },
  ],
};

function renderGate(props: Partial<Parameters<typeof RequiredToolsGate>[0]> = {}) {
  const client = createTestQueryClient();
  client.setQueryData(qk.analyticsEnabled, true);
  return renderToStaticMarkup(
    withQueryClient(
      createElement(RequiredToolsGate, {
        result: missingBoth,
        checking: false,
        onRecheck: noop,
        ...props,
      }),
      client,
    ),
  );
}

describe("RequiredToolsGate", () => {
  test("shows a pending check without a success step", () => {
    const html = renderGate({ result: null });
    expect(html).toContain('data-testid="required-tools-gate"');
    expect(html).toContain('data-state="checking"');
    expect(html).toContain('data-testid="required-tools-checking"');
    expect(html).toContain("Checking that Git and an agent CLI are installed");
    expect(html).not.toContain("everything is fine");
    expect(html).not.toContain('data-testid="required-tools-recheck"');
  });

  test("names missing tools and how to install them", () => {
    const html = renderGate({ onOpenDocs: noop });
    expect(html).toContain('data-state="missing"');
    expect(html).toContain("Required tools are missing");
    expect(html).toContain('data-testid="required-tool-git"');
    expect(html).toContain('data-found="false"');
    expect(html).toContain("not found");
    expect(html).toContain("Install Git and make sure it is on your PATH.");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Check again");
    expect(html).toContain("Open install page");
    expect(html).not.toContain("ENOENT");
    expect(html).not.toContain("spawn ");
  });

  test("shows found tools with their resolved detail", () => {
    const html = renderGate({
      result: {
        ok: false,
        warnings: ["Sandbox isolation is optional."],
        installedHarnesses: [{ name: "claude-code", displayName: "Claude Code" }],
        tools: [
          {
            id: "git",
            label: "Git",
            required: true,
            found: true,
            detail: "/usr/bin/git",
          },
          {
            id: "agent-harness",
            label: "Agent CLI",
            required: true,
            found: false,
            hint: "Install at least one supported agent CLI.",
          },
        ],
      },
    });
    expect(html).toContain("/usr/bin/git");
    expect(html).toContain('data-testid="required-tool-git"');
    expect(html).toContain("Sandbox isolation is optional.");
    expect(html).toContain("Install at least one supported agent CLI.");
  });

  test("disables Check again while a re-check is in flight", () => {
    const html = renderGate({ checking: true });
    expect(html).toContain("Checking…");
    expect(html).toContain("disabled");
    expect(html).not.toContain(">Check again<");
  });

  test("surfaces a probe error with retry", () => {
    const html = renderGate({ result: null, errorMessage: "Main process unavailable" });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('data-testid="required-tools-title"');
    expect(html).toContain("Couldn&#x27;t check required tools");
    expect(html).toContain("Main process unavailable");
    expect(html).toContain("Check again");
  });
});
