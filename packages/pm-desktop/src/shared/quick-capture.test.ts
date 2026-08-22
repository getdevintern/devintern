import { describe, expect, test } from "bun:test";
import {
  DEFAULT_QUICK_CAPTURE_ACCELERATOR,
  MAX_CAPTURE_CHARS,
  acceleratorFromKeyboardEvent,
  isValidAcceleratorShape,
  looksLikeFigmaUrl,
  looksLikeStackTrace,
  prettyAccelerator,
  quickCaptureConflictMessage,
  resolveQuickCaptureAccelerator,
  sanitizeCapturedText,
} from "./quick-capture.ts";

describe("looksLikeFigmaUrl", () => {
  test("matches figma design URLs anywhere in the text", () => {
    expect(looksLikeFigmaUrl("https://www.figma.com/design/AbCd?node-id=1-2")).toBe(true);
    expect(looksLikeFigmaUrl("https://acme.figma.com/file/X/Y")).toBe(true);
    expect(looksLikeFigmaUrl("check this https://figma.com/design/x out")).toBe(true);
  });

  test("rejects non-figma URLs and plain text", () => {
    expect(looksLikeFigmaUrl("https://github.com/owner/repo")).toBe(false);
    expect(looksLikeFigmaUrl("figma.com is a nice site")).toBe(false);
    expect(looksLikeFigmaUrl("TypeError: boom")).toBe(false);
  });
});

describe("looksLikeStackTrace", () => {
  test("detects JS/V8 stack frames", () => {
    expect(looksLikeStackTrace("Error: boom\n    at fn (src/app.ts:12:5)\n    at main")).toBe(true);
  });

  test("detects Python tracebacks", () => {
    expect(looksLikeStackTrace("Traceback (most recent call last):\n  File x, line 1")).toBe(true);
  });

  test("detects typed error names on their own line", () => {
    expect(looksLikeStackTrace("NullPointerException\n at com.acme.App.run")).toBe(true);
  });

  test("does not flag ordinary prose or URLs", () => {
    expect(looksLikeStackTrace("Let's ship the new dashboard tomorrow")).toBe(false);
    expect(looksLikeStackTrace("https://www.figma.com/design/AbCd?node-id=1-2")).toBe(false);
  });
});

describe("sanitizeCapturedText", () => {
  test("null/undefined/non-string becomes an empty prompt capture", () => {
    expect(sanitizeCapturedText(null)).toEqual({ text: null, sourceType: "prompt" });
    expect(sanitizeCapturedText(undefined)).toEqual({ text: null, sourceType: "prompt" });
    // @ts-expect-error runtime guard for non-string input
    expect(sanitizeCapturedText(42)).toEqual({ text: null, sourceType: "prompt" });
  });

  test("empty, tiny, or control-only text is not useful", () => {
    expect(sanitizeCapturedText("")).toEqual({ text: null, sourceType: "prompt" });
    expect(sanitizeCapturedText("   \n\t  ")).toEqual({ text: null, sourceType: "prompt" });
    expect(sanitizeCapturedText("ab")).toEqual({ text: null, sourceType: "prompt" });
  });

  test("plain useful text maps to the prompt tab and trims whitespace", () => {
    expect(sanitizeCapturedText("  Standup notes: fix login flow \n")).toEqual({
      text: "Standup notes: fix login flow",
      sourceType: "prompt",
    });
  });

  test("figma URL maps to the figma tab", () => {
    expect(sanitizeCapturedText("https://www.figma.com/design/A1?node-id=2-3").sourceType).toBe(
      "figma",
    );
  });

  test("stack-trace-like text maps to the log tab", () => {
    const trace = "Uncaught TypeError: x is not a function\n    at render (app.js:9:13)";
    expect(sanitizeCapturedText(trace).sourceType).toBe("log");
  });

  test("huge clipboard paste is treated as noise, not prefilled", () => {
    const huge = "x".repeat(MAX_CAPTURE_CHARS + 1);
    expect(sanitizeCapturedText(huge)).toEqual({ text: null, sourceType: "prompt" });
  });

  test("text within the cap is kept whole", () => {
    const big = "y".repeat(MAX_CAPTURE_CHARS);
    expect(sanitizeCapturedText(big)).toEqual({ text: big, sourceType: "prompt" });
  });
});

describe("resolveQuickCaptureAccelerator", () => {
  test("falls back to the documented default", () => {
    expect(resolveQuickCaptureAccelerator(undefined)).toBe(DEFAULT_QUICK_CAPTURE_ACCELERATOR);
    expect(resolveQuickCaptureAccelerator(null)).toBe(DEFAULT_QUICK_CAPTURE_ACCELERATOR);
    expect(resolveQuickCaptureAccelerator("   ")).toBe(DEFAULT_QUICK_CAPTURE_ACCELERATOR);
  });

  test("keeps a trimmed custom binding", () => {
    expect(resolveQuickCaptureAccelerator(" Alt+Q ")).toBe("Alt+Q");
  });
});

describe("isValidAcceleratorShape", () => {
  test("accepts modifier combos and lone F-keys", () => {
    expect(isValidAcceleratorShape(DEFAULT_QUICK_CAPTURE_ACCELERATOR)).toBe(true);
    expect(isValidAcceleratorShape("CmdOrCtrl+Alt+K")).toBe(true);
    expect(isValidAcceleratorShape("F9")).toBe(true);
    expect(isValidAcceleratorShape("Control+Shift+9")).toBe(true);
  });

  test("rejects bare keys, unknown parts, and garbage", () => {
    expect(isValidAcceleratorShape("K")).toBe(false);
    expect(isValidAcceleratorShape("Space")).toBe(false);
    expect(isValidAcceleratorShape("")).toBe(false);
    expect(isValidAcceleratorShape("Ctrl++")).toBe(false);
    expect(isValidAcceleratorShape("CommandOrControl+NotAKey")).toBe(false);
    expect(isValidAcceleratorShape("Ctrl+Shift+Space\nplus")).toBe(false);
  });
});

describe("acceleratorFromKeyboardEvent", () => {
  const base = { key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

  test("maps Cmd+Shift+Space on macOS-style events", () => {
    expect(acceleratorFromKeyboardEvent({ ...base, key: " ", metaKey: true, shiftKey: true })).toBe(
      "Command+Shift+Space",
    );
  });

  test("maps Ctrl+Shift+J with Control first-class", () => {
    expect(acceleratorFromKeyboardEvent({ ...base, key: "j", ctrlKey: true })).toBe("Control+J");
  });

  test("maps arrow keys and F-keys", () => {
    expect(acceleratorFromKeyboardEvent({ ...base, key: "ArrowUp", ctrlKey: true })).toBe(
      "Control+Up",
    );
    expect(acceleratorFromKeyboardEvent({ ...base, key: "F8" })).toBe("F8");
  });

  test("rejects modifier-only presses and unmodified plain keys", () => {
    expect(acceleratorFromKeyboardEvent({ ...base, key: "Shift", shiftKey: true })).toBeNull();
    expect(acceleratorFromKeyboardEvent({ ...base, key: "a" })).toBeNull();
    expect(acceleratorFromKeyboardEvent({ ...base, key: "?" })).toBeNull();
  });

  test("Escape returns null so the recorder can cancel", () => {
    expect(acceleratorFromKeyboardEvent({ ...base, key: "Escape", ctrlKey: true })).toBeNull();
  });
});

describe("prettyAccelerator", () => {
  test("renders CommandOrControl per platform", () => {
    expect(prettyAccelerator(DEFAULT_QUICK_CAPTURE_ACCELERATOR, true)).toBe("Cmd+Shift+Space");
    expect(prettyAccelerator(DEFAULT_QUICK_CAPTURE_ACCELERATOR, false)).toBe("Ctrl+Shift+Space");
  });
});

describe("quickCaptureConflictMessage", () => {
  test("names the accelerator and how to change it", () => {
    const message = quickCaptureConflictMessage("Ctrl+Shift+Space");
    expect(message).toContain("could not be registered");
    expect(message).toContain("Record a different combination");
    expect(message).toContain("Settings → Quick Capture");
  });
});
