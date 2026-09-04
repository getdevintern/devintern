import { afterAll, describe, expect, test } from "bun:test";
import type { IpcResult, RendererErrorReport } from "../../../shared/ipc-contract.ts";
import { installGlobalErrorReporting, reportRendererError } from "./error-reporting.ts";

/** Minimal stand-in for the renderer window: records listeners, exposes a mock pm bridge. */
class FakeWindow {
  listeners = new Map<string, Array<(event: unknown) => void>>();
  reports: Array<RendererErrorReport> = [];
  reportRendererErrorImpl: (report: RendererErrorReport) => Promise<IpcResult<null>> =
    async () => ({ ok: true, value: null });

  readonly pm = {
    reportRendererError: (report: RendererErrorReport): Promise<IpcResult<null>> => {
      this.reports.push(report);
      return this.reportRendererErrorImpl(report);
    },
  };

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const originalWindow = globalThis.window;
const fakeWindow = new FakeWindow();
globalThis.window = fakeWindow as unknown as Window & typeof globalThis;

// The module installs once per process by design; these tests share one flow:
// install (twice — the second must be a no-op), then dispatch through handlers.
installGlobalErrorReporting();
installGlobalErrorReporting();

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    globalThis.window = originalWindow;
  }
});

describe("error-reporting", () => {
  test("registers window error and rejection handlers exactly once", () => {
    expect(fakeWindow.listeners.get("error")?.length).toBe(1);
    expect(fakeWindow.listeners.get("unhandledrejection")?.length).toBe(1);
  });

  test("window error events are forwarded with kind and stack", () => {
    fakeWindow.dispatch("error", { message: "Boom", error: new Error("Boom") });
    expect(fakeWindow.reports).toHaveLength(1);
    expect(fakeWindow.reports[0]?.kind).toBe("error");
    expect(fakeWindow.reports[0]?.message).toBe("Boom");
    expect(fakeWindow.reports[0]?.stack).toContain("Error: Boom");
  });

  test("resource-load style errors (no message, no error) are dropped", () => {
    fakeWindow.dispatch("error", {});
    expect(fakeWindow.reports).toHaveLength(1);
  });

  test("unhandled rejections forward Error and plain reasons", () => {
    fakeWindow.dispatch("unhandledrejection", { reason: new Error("Rejected") });
    fakeWindow.dispatch("unhandledrejection", { reason: "plain string" });

    expect(fakeWindow.reports).toHaveLength(3);
    expect(fakeWindow.reports[1]?.kind).toBe("unhandledrejection");
    expect(fakeWindow.reports[1]?.message).toBe("Rejected");
    expect(fakeWindow.reports[2]?.message).toBe("plain string");
  });

  test("reportRendererError swallows bridge failures", async () => {
    fakeWindow.reportRendererErrorImpl = () => Promise.reject(new Error("bridge gone"));
    expect(() =>
      reportRendererError({ kind: "error", message: "survives rejection" }),
    ).not.toThrow();

    fakeWindow.pm.reportRendererError = () => {
      throw new Error("sync bridge failure");
    };
    expect(() =>
      reportRendererError({ kind: "error", message: "survives sync throw" }),
    ).not.toThrow();

    // Let the swallowed rejection settle so bun does not flag it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
