import { describe, expect, test } from "bun:test";
import { extractTextFromADF } from "./src/index";

describe("text-formatter extractTextFromADF", () => {
  test("flattens ADF content by joining arrays with spaces", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "world" },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Again" }],
        },
      ],
    };

    const text = extractTextFromADF(doc, { arrayJoinWith: " " });
    expect(text).toBe("Hello world Again");
  });
});
