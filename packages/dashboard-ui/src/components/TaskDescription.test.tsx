import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskDescription } from "@/components/TaskDescription";

test("renders a description as markdown", () => {
  const html = renderToStaticMarkup(
    createElement(TaskDescription, { description: "# Task\n\nBuild the **thing**." }),
  );

  expect(html).toContain("<h1");
  expect(html).toContain("<strong");
});

test("shows a placeholder when the ticket has no description", () => {
  for (const description of [undefined, "", "   \n\t"]) {
    const html = renderToStaticMarkup(createElement(TaskDescription, { description }));

    expect(html).toContain("No description provided.");
  }
});

test("long descriptions are collapsed behind a show-more toggle", () => {
  const long = "word ".repeat(500); // > PREVIEW_LENGTH chars
  const html = renderToStaticMarkup(createElement(TaskDescription, { description: long }));

  expect(html).toContain("show more");
  expect(html).not.toContain("show less");
});

test("short descriptions need no toggle", () => {
  const html = renderToStaticMarkup(
    createElement(TaskDescription, { description: "A short task." }),
  );

  expect(html).not.toContain("show more");
  expect(html).toContain("A short task.");
});
