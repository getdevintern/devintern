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
