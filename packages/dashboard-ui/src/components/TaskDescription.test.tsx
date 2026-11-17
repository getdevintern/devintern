import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskDescription, splitTaskDescription } from "@/components/TaskDescription";

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

test("splitTaskDescription separates frontmatter and drops a duplicate title heading", () => {
  const { meta, body } = splitTaskDescription(
    "---\nkey: abc\ncreated_at: 2026-01-01\n---\n\n# My title\n\nBody text",
    "My title",
  );
  expect(meta).toEqual(["key: abc", "created_at: 2026-01-01"]);
  expect(body).toBe("Body text");
});
