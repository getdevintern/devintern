import { describe, expect, test } from "bun:test";
import { markdownToADFContent, textToADFDoc } from "./src/index";

describe("text-formatter ADF generation", () => {
  describe("textToADFDoc", () => {
    test("wraps content in an ADF doc", () => {
      const doc = textToADFDoc("This is plain text with enough length to be meaningful.");
      expect(doc.type).toBe("doc");
      expect(doc.version).toBe(1);
      expect(Array.isArray(doc.content)).toBe(true);
      expect(doc.content.length).toBeGreaterThan(0);
    });
  });

  describe("markdownToADFContent - inline formatting", () => {
    test("bold (**text**)", () => {
      const content = markdownToADFContent("This is **bold text** in a sentence.");
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("paragraph");
      expect(content[0]?.content).toEqual([
        { type: "text", text: "This is " },
        { type: "text", text: "bold text", marks: [{ type: "strong" }] },
        { type: "text", text: " in a sentence." },
      ]);
    });

    test("italic (*text*)", () => {
      const content = markdownToADFContent("This is *italic text* in a sentence.");
      expect(content[0]?.content).toEqual([
        { type: "text", text: "This is " },
        { type: "text", text: "italic text", marks: [{ type: "em" }] },
        { type: "text", text: " in a sentence." },
      ]);
    });

    test("inline code (`code`)", () => {
      const content = markdownToADFContent("Use `console.log()` to debug.");
      expect(content[0]?.content).toEqual([
        { type: "text", text: "Use " },
        { type: "text", text: "console.log()", marks: [{ type: "code" }] },
        { type: "text", text: " to debug." },
      ]);
    });

    test("mixed inline formatting in a single paragraph", () => {
      const content = markdownToADFContent("This has **bold**, *italic*, and `code`.");
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("paragraph");
      const inline = content[0]?.content || [];
      expect(inline.length).toBe(7);
      expect(inline[1]?.marks).toEqual([{ type: "strong" }]);
      expect(inline[3]?.marks).toEqual([{ type: "em" }]);
      expect(inline[5]?.marks).toEqual([{ type: "code" }]);
    });

    test("plain text without formatting", () => {
      const content = markdownToADFContent("This is plain text with no formatting.");
      expect(content[0]?.content).toEqual([
        { type: "text", text: "This is plain text with no formatting." },
      ]);
    });
  });

  describe("markdownToADFContent - headings", () => {
    test("H1 heading", () => {
      const content = markdownToADFContent("# Main Title\n\nBody text.");
      expect(content[0]?.type).toBe("heading");
      expect(content[0]?.attrs?.level).toBe(1);
      expect(content[0]?.content).toEqual([{ type: "text", text: "Main Title" }]);
    });

    test("H2 heading", () => {
      const content = markdownToADFContent("## Subtitle\n\nBody text.");
      expect(content[0]?.type).toBe("heading");
      expect(content[0]?.attrs?.level).toBe(2);
    });

    test("H3 heading", () => {
      const content = markdownToADFContent("### Section\n\nBody text.");
      expect(content[0]?.type).toBe("heading");
      expect(content[0]?.attrs?.level).toBe(3);
    });

    test("multiple headings with content", () => {
      const content = markdownToADFContent(
        "# Title\n\nSome content here.\n\n## Subtitle\n\nMore content goes here.",
      );
      expect(content).toHaveLength(4);
      expect(content[0]?.type).toBe("heading");
      expect(content[0]?.attrs?.level).toBe(1);
      expect(content[1]?.type).toBe("paragraph");
      expect(content[2]?.type).toBe("heading");
      expect(content[2]?.attrs?.level).toBe(2);
      expect(content[3]?.type).toBe("paragraph");
    });
  });

  describe("markdownToADFContent - lists", () => {
    test("bullet list with dash", () => {
      const content = markdownToADFContent("- First item\n- Second item\n- Third item");
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("bulletList");
      expect(content[0]?.content).toHaveLength(3);
      expect(content[0]?.content?.[0]?.type).toBe("listItem");
      expect(content[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("First item");
    });

    test("bullet list with asterisk", () => {
      const content = markdownToADFContent("* First item\n* Second item");
      expect(content[0]?.type).toBe("bulletList");
      expect(content[0]?.content).toHaveLength(2);
    });

    test("bullet list with plus sign", () => {
      const content = markdownToADFContent("+ First item\n+ Second item");
      expect(content[0]?.type).toBe("bulletList");
      expect(content[0]?.content).toHaveLength(2);
    });

    test("ordered list", () => {
      const content = markdownToADFContent("1. First step\n2. Second step\n3. Third step");
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("orderedList");
      expect(content[0]?.content).toHaveLength(3);
      expect(content[0]?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe("Second step");
    });

    test("list items with inline formatting", () => {
      const content = markdownToADFContent("- **Bold** item\n- *Italic* item\n- `Code` item");
      expect(content[0]?.type).toBe("bulletList");
      expect(content[0]?.content?.[0]?.content?.[0]?.content?.[0]?.marks).toEqual([
        { type: "strong" },
      ]);
      expect(content[0]?.content?.[1]?.content?.[0]?.content?.[0]?.marks).toEqual([{ type: "em" }]);
      expect(content[0]?.content?.[2]?.content?.[0]?.content?.[0]?.marks).toEqual([
        { type: "code" },
      ]);
    });
  });

  describe("markdownToADFContent - code blocks", () => {
    test("code block without language defaults to text", () => {
      const content = markdownToADFContent("```\nconst x = 1;\nconst y = 2;\n```");
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("codeBlock");
      expect(content[0]?.attrs?.language).toBe("text");
      expect(content[0]?.content?.[0]?.text).toBe("const x = 1;\nconst y = 2;");
    });

    test("code block with language", () => {
      const content = markdownToADFContent("```javascript\nconst x = 1;\n```");
      expect(content[0]?.attrs?.language).toBe("javascript");
      expect(content[0]?.content?.[0]?.text).toBe("const x = 1;");
    });

    test("multiple code blocks separated by a paragraph", () => {
      const content = markdownToADFContent(
        "```js\ncode1();\n```\n\nSome text.\n\n```py\ncode2()\n```",
      );
      expect(content).toHaveLength(3);
      expect(content[0]?.type).toBe("codeBlock");
      expect(content[0]?.attrs?.language).toBe("js");
      expect(content[1]?.type).toBe("paragraph");
      expect(content[2]?.type).toBe("codeBlock");
      expect(content[2]?.attrs?.language).toBe("py");
    });

    test("preserves indentation inside code blocks", () => {
      const content = markdownToADFContent("```\n  function foo() {\n    return true;\n  }\n```");
      expect(content[0]?.content?.[0]?.text).toBe("  function foo() {\n    return true;\n  }");
    });
  });

  describe("markdownToADFContent - tables", () => {
    test("simple table with header and data rows", () => {
      const content = markdownToADFContent(
        "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |",
      );
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("table");
      expect(content[0]?.attrs?.isNumberColumnEnabled).toBe(false);
      expect(content[0]?.attrs?.layout).toBe("default");
    });

    test("table header cells are tableHeader nodes", () => {
      const content = markdownToADFContent(
        "| Name | Age | Location |\n|------|-----|----------|\n| Alice | 30 | NYC |",
      );
      const headerRow = content[0]?.content?.[0];
      expect(headerRow?.type).toBe("tableRow");
      expect(headerRow?.content?.[0]?.type).toBe("tableHeader");
      expect(headerRow?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("Name");
      expect(headerRow?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe("Age");
    });

    test("table data cells are tableCell nodes", () => {
      const content = markdownToADFContent(
        "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |",
      );
      const dataRow1 = content[0]?.content?.[1];
      const dataRow2 = content[0]?.content?.[2];
      expect(dataRow1?.content?.[0]?.type).toBe("tableCell");
      expect(dataRow1?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("Alice");
      expect(dataRow1?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe("30");
      expect(dataRow2?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("Bob");
    });

    test("table cells support inline formatting", () => {
      const content = markdownToADFContent(
        "| Feature | Status |\n|---------|--------|\n| **Auth** | `done` |",
      );
      const dataRow = content[0]?.content?.[1];
      expect(dataRow?.content?.[0]?.content?.[0]?.content?.[0]?.marks).toEqual([
        { type: "strong" },
      ]);
      expect(dataRow?.content?.[1]?.content?.[0]?.content?.[0]?.marks).toEqual([{ type: "code" }]);
    });

    test("table cells preserve emoji characters", () => {
      const content = markdownToADFContent(
        "| Status | Icon |\n|--------|------|\n| Done | ✅ |\n| Progress | 🔄 |",
      );
      expect(content[0]?.content?.[1]?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe("✅");
      expect(content[0]?.content?.[2]?.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe("🔄");
    });

    test("tables can be disabled via options", () => {
      const content = markdownToADFContent("| Name | Age |\n|------|-----|\n| Alice | 30 |", {
        includeTables: false,
      });
      expect(content.every((node) => node.type !== "table")).toBe(true);
    });

    test("paragraphJoinWith: '\\n' preserves intra-paragraph newlines", () => {
      const content = markdownToADFContent("line 1\nline 2", { paragraphJoinWith: "\n" });
      expect(content[0]?.type).toBe("paragraph");
      expect(content[0]?.content?.[0]?.text).toBe("line 1\nline 2");
    });
  });

  describe("markdownToADFContent - mixed content", () => {
    test("heading followed by paragraph", () => {
      const content = markdownToADFContent("# Title\n\nThis is a paragraph.");
      expect(content).toHaveLength(2);
      expect(content[0]?.type).toBe("heading");
      expect(content[1]?.type).toBe("paragraph");
    });

    test("paragraph followed by list", () => {
      const content = markdownToADFContent("Introduction text.\n\n- First item\n- Second item");
      expect(content).toHaveLength(2);
      expect(content[0]?.type).toBe("paragraph");
      expect(content[1]?.type).toBe("bulletList");
    });

    test("code block between paragraphs", () => {
      const content = markdownToADFContent(
        "Before code block.\n\n```js\ncode();\n```\n\nAfter code block.",
      );
      expect(content).toHaveLength(3);
      expect(content[0]?.type).toBe("paragraph");
      expect(content[1]?.type).toBe("codeBlock");
      expect(content[2]?.type).toBe("paragraph");
    });

    test("complex document with headings, list, code, and table", () => {
      const markdown = `# Implementation Summary

I've completed the following tasks:

1. Created authentication module
2. Added **database migrations**
3. Implemented \`UserService\` class

## Code Changes

\`\`\`typescript
class UserService {}
\`\`\`

## Test Results

| Test | Status |
|------|--------|
| Unit | ✅ Pass |

Implementation complete!`;

      const content = markdownToADFContent(markdown);

      expect(content[0]?.type).toBe("heading");
      expect(content[1]?.type).toBe("paragraph");
      expect(content[2]?.type).toBe("orderedList");
      expect(content[3]?.type).toBe("heading");
      expect(content[4]?.type).toBe("codeBlock");
      expect(content[5]?.type).toBe("heading");
      expect(content[6]?.type).toBe("table");
      expect(content[7]?.type).toBe("paragraph");
    });

    test("collapses runs of empty lines between paragraphs", () => {
      const content = markdownToADFContent("First paragraph.\n\n\n\nSecond paragraph.");
      expect(content).toHaveLength(2);
      expect(content[0]?.type).toBe("paragraph");
      expect(content[1]?.type).toBe("paragraph");
    });
  });

  describe("edge cases / stability", () => {
    test("does not throw on empty string", () => {
      expect(() => markdownToADFContent("")).not.toThrow();
      const content = markdownToADFContent("");
      expect(content).toHaveLength(0);
    });

    test("textToADFDoc provides fallback paragraph for empty input", () => {
      const doc = textToADFDoc("");
      expect(doc.content.length).toBeGreaterThan(0);
      expect(doc.content[0]?.type).toBe("paragraph");
    });

    test("does not throw on unclosed markers", () => {
      expect(() => markdownToADFContent("This has **unclosed bold and *italic")).not.toThrow();
    });
  });
});
