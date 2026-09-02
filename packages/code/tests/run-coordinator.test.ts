import { describe, expect, test } from "bun:test";

import { RunCoordinator } from "../src/lib/run-coordinator";

describe("RunCoordinator", () => {
  test("stays transparent until live estimations enable it", async () => {
    const coordinator = new RunCoordinator(false);
    const release = await coordinator.acquire();
    let ran = false;
    await coordinator.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    release();

    coordinator.enable();
    const held = await coordinator.acquire();
    const waiting = coordinator.run(async () => "ran");
    let settled = false;
    void waiting.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    held();
    expect(await waiting).toBe("ran");

    coordinator.disableWhenIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const transparentRelease = await coordinator.acquire();
    let transparentRan = false;
    await coordinator.run(async () => {
      transparentRan = true;
    });
    expect(transparentRan).toBe(true);
    transparentRelease();
  });

  test("runs held operations one at a time in FIFO order", async () => {
    const coordinator = new RunCoordinator();
    const events: string[] = [];

    const first = coordinator.run(async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("first:end");
      return "a";
    });
    const second = coordinator.run(async () => {
      events.push("second:start");
      events.push("second:end");
      return "b";
    });

    // Both are queued before either finishes; FIFO order must hold.
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(await first).toBe("a");
  });

  test("releases on failure so the next operation still runs", async () => {
    const coordinator = new RunCoordinator();
    await expect(
      coordinator.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    let ran = false;
    await coordinator.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("waits for an explicitly acquired slot to be released", async () => {
    const coordinator = new RunCoordinator();
    let secondRan = false;
    let firstRelease!: () => void;

    const first = coordinator.acquire().then((release) => {
      firstRelease = release;
    });
    await first;

    const second = coordinator.run(async () => {
      secondRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondRan).toBe(false);

    firstRelease();
    await second;
    expect(secondRan).toBe(true);
  });
});
