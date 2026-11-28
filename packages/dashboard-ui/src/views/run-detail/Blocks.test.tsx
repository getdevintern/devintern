import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TaskDependent } from "@/lib/api";
import { BlocksSection } from "./Blocks";

function render(blocks: TaskDependent[] | undefined): string {
  return renderToStaticMarkup(createElement(BlocksSection, { blocks }));
}

test("lists each queued dependent as a link to its queued row", () => {
  const html = render([
    {
      key: "local-onboarding-recover",
      title: "Recover from a tracker repo mismatch",
      queuedItemId: "ad-hoc:9",
      dependencyState: "blocked",
      dependencyReason: "local-github-token-errors failed",
    },
    { key: "PROJ-9", title: "PROJ-9", queuedItemId: "tracker::PROJ-9" },
  ]);
  expect(html).toContain(">Blocks</h3>");
  expect(html).toMatch(
    /<a href="#\/" class="ref-link" title="Show local-onboarding-recover in the queue">Recover from a tracker repo mismatch<\/a>/,
  );
  expect(html).toContain("Blocked: local-github-token-errors failed");
  expect(html).toMatch(/title="Show PROJ-9 in the queue">PROJ-9<\/a>/);
  expect(html).toContain("Ready to start");
});

test("renders nothing when no queued task waits on this one", () => {
  expect(render([])).toBe("");
  expect(render(undefined)).toBe("");
});
