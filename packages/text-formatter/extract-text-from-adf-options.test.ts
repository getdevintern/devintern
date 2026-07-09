import { describe, expect, test } from "bun:test";
import { extractTextFromADF } from "./src/index";

describe("text-formatter extractTextFromADF options", () => {
  test("extracts text and preserves top-level heading/paragraph newlines", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "First paragraph" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph" }],
        },
      ],
    };

    const text = extractTextFromADF(doc, {
      topLevelParagraphNewline: true,
      topLevelHeadingNewline: true,
    });
    expect(text).toBe("Title\nFirst paragraph\nSecond paragraph");
  });

  test("returns input when given a string", () => {
    expect(extractTextFromADF("hello")).toBe("hello");
  });

  test("returns empty string for undefined", () => {
    expect(extractTextFromADF(undefined)).toBe("");
  });
});
