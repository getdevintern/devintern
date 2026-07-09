import { describe, expect, test } from "bun:test";
import { parseTextWithFormatting } from "./src/index";

describe("text-formatter parseTextWithFormatting", () => {
  test("handles nested formatting content safely", () => {
    const result = parseTextWithFormatting("Normal **bold *both* bold** normal");
    expect(result.length).toBeGreaterThan(1);
    expect(result.some((node) => node.marks?.[0]?.type === "strong")).toBe(true);
  });

  test("handles adjacent formatting segments", () => {
    const result = parseTextWithFormatting("**bold***italic*");
    expect(result.length).toBeGreaterThan(1);
  });

  test("handles empty string", () => {
    const result = parseTextWithFormatting("");
    expect(result).toEqual([{ type: "text", text: "" }]);
  });
});
