import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RunResult } from "@/components/RunResult";

test("renders a ticket key as text when its tracker provides no URL", () => {
  const html = renderToStaticMarkup(createElement(RunResult, { run: { ticketKey: "ENG-42" } }));

  expect(html).toContain("ENG-42");
  expect(html).not.toContain("<a");
});

test("renders a ticket key as a link when its tracker provides a URL", () => {
  const html = renderToStaticMarkup(
    createElement(RunResult, {
      run: { ticketKey: "ENG-42", ticketUrl: "https://tracker.test/ENG-42" },
    }),
  );

  expect(html).toContain("ENG-42");
  expect(html).toContain('href="https://tracker.test/ENG-42"');
});

test("renders a PR reference as a link to the affected PR", () => {
  const html = renderToStaticMarkup(
    createElement(RunResult, {
      run: { prNumber: 42, prUrl: "https://github.com/acme/widgets/pull/42" },
    }),
  );

  expect(html).toContain("#42");
  expect(html).toContain('href="https://github.com/acme/widgets/pull/42"');
});

test("links legacy PR references that have a repo slug but no recorded URL", () => {
  const html = renderToStaticMarkup(
    createElement(RunResult, { run: { prNumber: 42, repo: "acme/widgets" } }),
  );

  expect(html).toContain("#42");
  expect(html).toContain('href="https://github.com/acme/widgets/pull/42"');
});

test("a task run that created a PR links its result to the PR", () => {
  const html = renderToStaticMarkup(
    createElement(RunResult, {
      run: {
        ticketKey: "ENG-42",
        ticketUrl: "https://tracker.test/ENG-42",
        prNumber: 9,
        prUrl: "https://github.com/acme/widgets/pull/9",
      },
    }),
  );

  expect(html).toContain('href="https://github.com/acme/widgets/pull/9"');
});

test("a run with no result yet shows a dash and no PR placeholder", () => {
  const html = renderToStaticMarkup(createElement(RunResult, { run: {} }));

  expect(html).toContain("–");
  expect(html).not.toContain("<a");
  expect(html).not.toContain("#PR");
});
