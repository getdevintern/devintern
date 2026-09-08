import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createWorkerShutdownHandler } from "../src/worker";

describe("createWorkerShutdownHandler", () => {
  const originalLog = console.log;
  const originalWarn = console.warn;

  beforeEach(() => {
    console.log = () => undefined;
    console.warn = () => undefined;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });

  test("stops acquirers, awaits mode cleanup, then releases ownership", async () => {
    const order: string[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [
        {
          name: "first",
          stop: async () => {
            order.push("stop:first");
          },
        },
        {
          name: "second",
          stop: () => {
            order.push("stop:second");
          },
        },
      ],
      onShutdown: async () => {
        order.push("hook");
      },
      lock: { release: () => order.push("lock") },
      capture: { stop: () => order.push("capture") },
      flush: async () => {
        order.push("flush");
      },
      exit: (code) => order.push(`exit:${code}`),
    });

    await handler("SIGTERM");

    expect(order).toEqual([
      "stop:first",
      "stop:second",
      "hook",
      "lock",
      "capture",
      "flush",
      "exit:0",
    ]);
  });

  test("continues cleanup when an acquirer and shutdown hook fail", async () => {
    const order: string[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [
        {
          name: "broken",
          stop: () => {
            order.push("stop");
            throw new Error("stop failed");
          },
        },
      ],
      onShutdown: () => {
        order.push("hook");
        throw new Error("hook failed");
      },
      lock: { release: () => order.push("lock") },
      flush: async () => {
        order.push("flush");
      },
      exit: (code) => order.push(`exit:${code}`),
    });

    await handler("SIGTERM");

    expect(order).toEqual(["stop", "hook", "lock", "flush", "exit:0"]);
  });

  test("bounds a hanging mode-specific shutdown hook", async () => {
    const order: string[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [],
      // oxlint-disable-next-line promise/avoid-new -- intentionally never settles.
      onShutdown: () => new Promise(() => undefined),
      shutdownTimeoutMs: 5,
      lock: { release: () => order.push("lock") },
      flush: async () => undefined,
      exit: (code) => order.push(`exit:${code}`),
    });

    await handler("SIGTERM");

    expect(order).toEqual(["lock", "exit:0"]);
  });

  test("forces a non-zero exit when a second signal arrives", async () => {
    let releaseStop!: () => void;
    // oxlint-disable-next-line promise/avoid-new -- controlled gate for signal ordering.
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const exits: number[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [{ name: "slow", stop: () => stopGate }],
      lock: { release: () => undefined },
      flush: async () => undefined,
      exit: (code) => exits.push(code),
    });

    const firstSignal = handler("SIGTERM");
    await Promise.resolve();
    await handler("SIGINT");

    expect(exits).toEqual([1]);
    releaseStop();
    await firstSignal;
    expect(exits).toEqual([1]);
  });

  test("exits after failures in the final cleanup stages", async () => {
    const order: string[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [],
      lock: {
        release: () => {
          order.push("lock");
          throw new Error("release failed");
        },
      },
      capture: {
        stop: () => {
          order.push("capture");
          throw new Error("capture failed");
        },
      },
      flush: async () => {
        order.push("flush");
        throw new Error("flush failed");
      },
      exit: (code) => order.push(`exit:${code}`),
    });

    await handler("SIGTERM");

    expect(order).toEqual(["lock", "capture", "flush", "exit:0"]);
  });
});
