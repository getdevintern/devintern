import { describe, expect, test } from "bun:test";
import { sanitizeJiraOutput } from "./src/index";

describe("text-formatter sanitizeJiraOutput", () => {
  test("strips ANSI color codes", () => {
    const result = sanitizeJiraOutput("\x1b[32mGreen text\x1b[0m and normal text.");
    expect(result).toBe("Green text and normal text.");
  });

  test("normalizes CRLF and CR to LF", () => {
    const result = sanitizeJiraOutput("line 1\r\nline 2\rline 3");
    expect(result).toBe("line 1\nline 2\nline 3");
  });

  test("collapses excessive newlines by default", () => {
    const result = sanitizeJiraOutput("First paragraph.\n\n\n\nSecond paragraph.");
    expect(result).toBe("First paragraph.\n\nSecond paragraph.");
  });

  test("preserves excessive newlines when collapseExcessNewlines is false", () => {
    const result = sanitizeJiraOutput("First.\n\n\n\nSecond.", {
      collapseExcessNewlines: false,
    });
    expect(result).toBe("First.\n\n\n\nSecond.");
  });

  test("truncates output exceeding maxLength and appends a note", () => {
    const result = sanitizeJiraOutput("a".repeat(10000), { maxLength: 8000 });
    expect(result.length).toBeLessThanOrEqual(8100);
    expect(result).toContain("[Output truncated due to length]");
  });

  test("returns fallback message when output is shorter than minLength", () => {
    const result = sanitizeJiraOutput("Done", {
      minLength: 50,
      fallbackMessage: "Fallback here.",
    });
    expect(result).toBe("Fallback here.");
  });

  test("returns default fallback message for empty output with minLength", () => {
    const result = sanitizeJiraOutput("", { minLength: 1 });
    expect(result).toBe(
      "@devintern completed the implementation successfully. Please check the committed changes for details.",
    );
  });

  test("trims surrounding whitespace", () => {
    const result = sanitizeJiraOutput("  hello world  ");
    expect(result).toBe("hello world");
  });
});
