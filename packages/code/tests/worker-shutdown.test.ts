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

  test("starts an admission drain before stopping acquirers and awaits it afterward", async () => {
    const order: string[] = [];
    let finishDrain!: () => void;
    // oxlint-disable-next-line promise/avoid-new -- controlled gate for shutdown ordering.
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const handler = createWorkerShutdownHandler({
      acquirers: [
        {
          name: "scheduled",
          stop: () => {
            order.push("stop");
            finishDrain();
          },
        },
      ],
      beginShutdown: () => {
        order.push("begin");
        return drain;
      },
      onShutdown: () => {
        order.push("hook");
      },
      lock: { release: () => order.push("lock") },
      flush: async () => undefined,
      exit: (code) => order.push(`exit:${code}`),
    });

    await handler("SIGTERM");

    expect(order).toEqual(["begin", "stop", "hook", "lock", "exit:0"]);
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

  test("finalExitCode runs after cleanup and can override the exit status", async () => {
    const order: string[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [],
      lock: { release: () => order.push("lock") },
      flush: async () => {
        order.push("flush");
      },
      finalExitCode: () => {
        order.push("final");
        return 1;
      },
      exit: (code) => order.push(`exit:${code}`),
    });

    await handler("SIGTERM");

    // The hook runs last (after the lock release), so a post-update successor
    // spawn sees the workspace lock already released.
    expect(order).toEqual(["lock", "flush", "final", "exit:1"]);
  });

  test("a void finalExitCode keeps the zero exit status", async () => {
    const exits: number[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [],
      lock: { release: () => undefined },
      flush: async () => undefined,
      finalExitCode: () => undefined,
      exit: (code) => exits.push(code),
    });

    await handler("SIGTERM");

    expect(exits).toEqual([0]);
  });

  test("a failing finalExitCode exits zero instead of crashing the handler", async () => {
    const exits: number[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [],
      lock: { release: () => undefined },
      flush: async () => undefined,
      finalExitCode: () => {
        throw new Error("hook failed");
      },
      exit: (code) => exits.push(code),
    });

    await handler("SIGTERM");

    expect(exits).toEqual([0]);
  });

  test("awaits an async finalExitCode before exiting", async () => {
    const exits: number[] = [];
    const handler = createWorkerShutdownHandler({
      acquirers: [],
      lock: { release: () => undefined },
      flush: async () => undefined,
      finalExitCode: async () => 1,
      exit: (code) => exits.push(code),
    });

    await handler("SIGTERM");

    expect(exits).toEqual([1]);
  });
});
