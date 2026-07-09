import { describe, expect, test } from "bun:test";
import { textToADF } from "./src/clients/jira-adf.ts";

describe("textToADF", () => {
  test("returns an ADF doc root node", () => {
    const doc = textToADF("Hello **world**");
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(Array.isArray(doc.content)).toBe(true);
    expect(doc.content.length).toBeGreaterThan(0);
  });
});
