import { describe, expect, test } from "bun:test";
import type { QuickCaptureEvent } from "../shared/ipc-contract.ts";
import { createQuickCaptureLatch } from "./quick-capture-latch.ts";

const event: QuickCaptureEvent = { text: "note", sourceType: "prompt" };

describe("quick capture latch", () => {
  test("flushes a latched early event to the first subscriber", () => {
    const latch = createQuickCaptureLatch();
    latch.noteEvent(event);

    const seen: QuickCaptureEvent[] = [];
    latch.subscribe((flushed) => seen.push(flushed));
    expect(seen).toEqual([event]);
  });

  test("keeps only the latest payload when several arrive before subscribing", () => {
    const latch = createQuickCaptureLatch();
    latch.noteEvent({ text: "first", sourceType: "log" });
    latch.noteEvent({ text: null, sourceType: "prompt" });

    const seen: QuickCaptureEvent[] = [];
    latch.subscribe((flushed) => seen.push(flushed));
    expect(seen).toEqual([{ text: null, sourceType: "prompt" }]);
  });

  test("does not double-deliver once a subscriber is attached", () => {
    const latch = createQuickCaptureLatch();
    const seen: QuickCaptureEvent[] = [];

    // Live events after subscription flow through the plain ipcRenderer.on
    // listener in preload; the latch itself stays passive.
    latch.subscribe((flushed) => seen.push(flushed));
    latch.noteEvent(event);
    expect(seen).toEqual([]);

    // A second subscriber does not replay anything either.
    latch.subscribe(() => {});
    expect(seen).toEqual([]);
  });
});
