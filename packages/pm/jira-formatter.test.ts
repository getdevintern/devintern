import { describe, expect, test } from "bun:test";
import { JiraFormatter } from "./lib/utils/jira-formatter";

describe("devpm JiraFormatter (ADF)", () => {
  describe("textToADF", () => {
    test("wraps content in an ADF doc", () => {
      const doc = JiraFormatter.textToADF(
        "This is plain text with enough length to be meaningful.",
      );

      expect(doc.type).toBe("doc");
      expect(doc.version).toBe(1);
      expect(Array.isArray(doc.content)).toBe(true);
      expect(doc.content?.length).toBeGreaterThan(0);
    });
  });

  describe("parseTextToADFContent - devpm behavior", () => {
    test("supports markdown table parsing for descriptions", () => {
      const content = JiraFormatter.parseTextToADFContent("| H1 |\n|---|\n| V1 |");
      expect(content[0]?.type).toBe("table");
      expect(content.some((node) => node.type === "table")).toBe(true);
    });

    test("preserves intra-paragraph newlines", () => {
      const content = JiraFormatter.parseTextToADFContent("line 1\nline 2");
      const firstTextNode = content[0]?.content?.[0];
      expect(firstTextNode?.type).toBe("text");
      expect(firstTextNode?.text).toBe("line 1\nline 2");
    });

    test("does not throw on malformed markdown", () => {
      expect(() =>
        JiraFormatter.parseTextToADFContent("This has **unclosed bold and *italic"),
      ).not.toThrow();
    });
  });
});
