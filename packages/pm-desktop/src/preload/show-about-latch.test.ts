import { describe, expect, test } from "bun:test";
import { createShowAboutLatch } from "./show-about-latch.ts";

describe("createShowAboutLatch", () => {
  test("latches an event that arrives before subscribe and flushes on subscribe", () => {
    const latch = createShowAboutLatch();
    let flushes = 0;

    latch.noteEvent();
    latch.subscribe(() => {
      flushes += 1;
    });

    expect(flushes).toBe(1);
  });

  test("does not latch when a subscriber is already active", () => {
    const latch = createShowAboutLatch();
    let flushes = 0;

    latch.subscribe(() => {
      flushes += 1;
    });
    latch.noteEvent();

    expect(flushes).toBe(0);
  });

  test("does not flush on subscribe when nothing was latched", () => {
    const latch = createShowAboutLatch();
    let flushes = 0;

    latch.subscribe(() => {
      flushes += 1;
    });

    expect(flushes).toBe(0);
  });

  test("latches again after unsubscribe between events", () => {
    const latch = createShowAboutLatch();
    let flushes = 0;

    const unsubscribe = latch.subscribe(() => {
      flushes += 1;
    });
    unsubscribe();

    latch.noteEvent();
    latch.subscribe(() => {
      flushes += 1;
    });

    expect(flushes).toBe(1);
  });

  test("flushes at most once per latched event", () => {
    const latch = createShowAboutLatch();
    let flushes = 0;

    latch.noteEvent();
    latch.noteEvent();
    latch.subscribe(() => {
      flushes += 1;
    });

    expect(flushes).toBe(1);

    latch.subscribe(() => {
      flushes += 1;
    });
    expect(flushes).toBe(1);
  });
});
