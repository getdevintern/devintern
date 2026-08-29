import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TicketKey } from "@/components/TicketKey";

test("renders a ticket key as text when no tracker URL exists", () => {
  const html = renderToStaticMarkup(createElement(TicketKey, { label: "ENG-42" }));

  expect(html).toContain("ENG-42");
  expect(html).not.toContain("<a");
});

test("renders a ticket key as a new-tab link when a tracker URL exists", () => {
  const html = renderToStaticMarkup(
    createElement(TicketKey, {
      label: "ENG-42",
      href: "https://acme.atlassian.net/browse/ENG-42",
    }),
  );

  expect(html).toContain("ENG-42");
  expect(html).toContain('href="https://acme.atlassian.net/browse/ENG-42"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noreferrer"');
});

test("falls back to a muted dash when there is no label", () => {
  const html = renderToStaticMarkup(createElement(TicketKey, { label: undefined }));

  expect(html).not.toContain("<a");
});
