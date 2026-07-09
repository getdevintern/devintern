import { describe, expect, test } from "bun:test";
import { formatInlineMarkdownToHtml, markdownToAsanaHtmlNotes } from "./src/index";

describe("formatInlineMarkdownToHtml", () => {
  test("converts bold, italic, and code", () => {
    expect(formatInlineMarkdownToHtml("**bold** and *italic* and `code`")).toBe(
      "<strong>bold</strong> and <em>italic</em> and <code>code</code>",
    );
  });

  test("escapes HTML in plain text", () => {
    expect(formatInlineMarkdownToHtml("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
  });
});

describe("markdownToAsanaHtmlNotes", () => {
  test("wraps content in body and converts headings without p tags", () => {
    const html = markdownToAsanaHtmlNotes("## Section\n\nBody text.");
    expect(html).toBe("<body><h2>Section</h2>\nBody text.</body>");
    expect(html).not.toContain("<p>");
  });

  test("converts bullet lists and checkboxes", () => {
    const html = markdownToAsanaHtmlNotes("- First\n- [ ] Todo item");
    expect(html).toBe("<body><ul><li>First</li><li>Todo item</li></ul></body>");
  });

  test("converts code blocks", () => {
    const html = markdownToAsanaHtmlNotes("```\nconst x = 1;\n```");
    expect(html).toBe("<body><pre>const x = 1;</pre></body>");
  });

  test("converts a typical PM story description", () => {
    const html = markdownToAsanaHtmlNotes(
      "## User Story\n\nAs a user, I want **login** so that I can save progress.\n\n## Acceptance Criteria\n\n- [ ] Can sign in\n- [ ] Session persists",
    );
    expect(html).toContain("<h2>User Story</h2>");
    expect(html).toContain("<strong>login</strong>");
    expect(html).toContain("<ul><li>Can sign in</li>");
    expect(html).not.toContain("<p>");
  });

  test("escapes comparison operators and ampersands in plain text", () => {
    const html = markdownToAsanaHtmlNotes("Use x < 10 & y > 0");
    expect(html).toBe("<body>Use x &lt; 10 &amp; y &gt; 0</body>");
  });

  test("does not throw on malformed markdown", () => {
    expect(() => markdownToAsanaHtmlNotes("**unclosed bold")).not.toThrow();
  });

  test("uses only Asana-supported tags", () => {
    const html = markdownToAsanaHtmlNotes(
      "## Section\n\n**Bold** and `code`\n\n- item\n\n```\na < b\n```\n\n---",
    );
    expect(html).not.toMatch(/<(p|div|span|br|h[3-6])\b/i);
  });
});
