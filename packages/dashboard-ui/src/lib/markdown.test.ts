import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, expect } from "bun:test";

import { Markdown, isSafeUrl } from "@/lib/markdown";

function render(md: string): string {
  return renderToStaticMarkup(createElement(Markdown, null, md));
}

test("headings are detected with their level", () => {
  const html = render("# H1\n\n## H2\n\n### H3\n\n###### H6");
  expect(html).toContain("<h1");
  expect(html).toContain(">H1</h1>");
  expect(html).toContain("<h2");
  expect(html).toContain(">H2</h2>");
  expect(html).toContain("<h3");
  expect(html).toContain(">H3</h3>");
  expect(html).toContain("<h6");
  expect(html).toContain(">H6</h6>");
});

test("fenced code blocks capture language and body", () => {
  const html = render("```ts\nconst x = 1;\n```");
  expect(html).toContain("<pre");
  expect(html).toContain('class="language-ts"');
  expect(html).toContain("const x = 1;");
});

test("fenced code block without language still parses", () => {
  const html = render("```\nplain code\n```");
  expect(html).toContain("<pre");
  expect(html).toContain("plain code");
});

test("unclosed code block runs to EOF", () => {
  const html = render("```js\nconst y = 2;");
  expect(html).toContain("<pre");
  expect(html).toContain("const y = 2;");
});

test("bullet lists are detected as unordered", () => {
  const html = render("- one\n- two\n- three");
  expect(html).toContain("<ul");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<li>two</li>");
  expect(html).toContain("<li>three</li>");
  expect(html).not.toContain("<ol");
});

test("task list items render checked state", () => {
  const html = render("- [x] done\n- [ ] todo");
  expect(html).toContain("✓");
  expect(html).toContain("done");
  expect(html).toContain("todo");
  // Unchecked item should not get a checkmark before "todo".
  expect(html.match(/✓/g)?.length).toBe(1);
});

test("ordered lists are detected as ordered", () => {
  const html = render("1. first\n2. second");
  expect(html).toContain("<ol");
  expect(html).toContain("<li>first</li>");
  expect(html).toContain("<li>second</li>");
});

test("blockquotes collect consecutive lines", () => {
  const html = render("> line one\n> line two");
  expect(html).toContain("<blockquote");
  expect(html).toContain("line one");
  expect(html).toContain("line two");
});

test("horizontal rule is detected", () => {
  expect(render("---")).toContain("<hr");
  expect(render("***")).toContain("<hr");
});

test("paragraphs collect until a block starter", () => {
  const html = render("intro line\nsecond line\n\n# Heading");
  expect(html).toContain("<p");
  expect(html).toContain("intro line");
  expect(html).toContain("second line");
  expect(html).toContain("<h1");
  expect(html).toContain(">Heading</h1>");
});

test("blank lines separate paragraphs", () => {
  const html = render("first\n\nsecond");
  expect(html.match(/<p/g)?.length).toBe(2);
  expect(html).toContain(">first</p>");
  expect(html).toContain(">second</p>");
});

test("CRLF line endings are normalized", () => {
  const html = render("a\r\nb\r\nc");
  expect(html).toContain("<p");
  expect(html).toContain("a");
  expect(html).toContain("b");
  expect(html).toContain("c");
});

test("inline bold italic code and safe links render", () => {
  const html = render("**bold** *italic* `code` [docs](https://example.com/path)");
  expect(html).toContain("<strong");
  expect(html).toContain("bold");
  expect(html).toContain("<em");
  expect(html).toContain("italic");
  expect(html).toContain("<code");
  expect(html).toContain("code");
  expect(html).toContain('href="https://example.com/path"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noreferrer noopener"');
});

test("unsafe link schemes are not rendered as anchors", () => {
  const html = render("[x](javascript:alert(1)) and [y](data:text/html,hi)");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("data:");
  expect(html).not.toContain("<a");
  expect(html).toContain("x");
  expect(html).toContain("y");
});

test("relative and http(s) URLs are allowed", () => {
  expect(isSafeUrl("/local")).toBe(true);
  expect(isSafeUrl("https://example.com")).toBe(true);
  expect(isSafeUrl("http://example.com")).toBe(true);
  expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  expect(isSafeUrl("data:text/html,hi")).toBe(false);
  expect(isSafeUrl("//evil.example")).toBe(false);
});

test("remote images are not rendered (no tracking pixel loads)", () => {
  const html = render("![pixel](https://evil.example/pixel)");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("evil.example");
  expect(html).not.toContain("src=");
});
