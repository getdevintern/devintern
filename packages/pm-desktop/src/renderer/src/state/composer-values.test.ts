import { describe, expect, test } from "bun:test";
import type { QuickCaptureEvent } from "../../../shared/ipc-contract.ts";
import { composerForCapture, initialComposerValues } from "./composer-values.ts";

function captureEvent(overrides?: Partial<QuickCaptureEvent>): QuickCaptureEvent {
  return { text: null, sourceType: "prompt", ...overrides };
}

describe("composerForCapture", () => {
  test("null text keeps the empty prompt composer untouched", () => {
    expect(composerForCapture(initialComposerValues, captureEvent())).toBe(initialComposerValues);
  });

  test("captured text prefills the inferred tab and selects it", () => {
    const next = composerForCapture(
      initialComposerValues,
      captureEvent({ text: "TypeError: boom\n at fn (a.js:1:1)", sourceType: "log" }),
    );
    expect(next.sourceType).toBe("log");
    expect(next.sourceContent.log).toContain("TypeError");
    // Other tabs stay empty so switching away does not show stale content.
    expect(next.sourceContent.prompt).toBe("");
    expect(next.sourceContent.figma).toBe("");
  });

  test("does not mutate the base composer", () => {
    const base = {
      ...initialComposerValues,
      sourceContent: { ...initialComposerValues.sourceContent },
    };
    composerForCapture(
      base,
      captureEvent({ text: "https://www.figma.com/design/x", sourceType: "figma" }),
    );
    expect(base.sourceType).toBe("prompt");
    expect(base.sourceContent.figma).toBe("");
  });
});
