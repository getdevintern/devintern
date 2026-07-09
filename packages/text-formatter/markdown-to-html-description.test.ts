import { describe, expect, test } from "bun:test";
import { markdownToHtmlDescription } from "./src/index";

describe("markdownToHtmlDescription", () => {
  test("converts headings and inline formatting to HTML", () => {
    const html = markdownToHtmlDescription("## Summary\n\n**Bold** detail");
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<div><strong>Bold</strong> detail</div>");
    expect(html).not.toContain("**Bold**");
    expect(html).not.toContain("<body>");
  });

  test("converts bullet lists", () => {
    const html = markdownToHtmlDescription("- First\n- Second");
    expect(html).toBe("<ul><li>First</li><li>Second</li></ul>");
  });

  test("escapes HTML in plain text", () => {
    const html = markdownToHtmlDescription("Use x < 10 & y > 0");
    expect(html).toBe("<div>Use x &lt; 10 &amp; y &gt; 0</div>");
  });
});
