import { describe, expect, test } from "bun:test";
import { IPC_CHANNELS } from "../shared/ipc-contract.ts";
import { notifyShowAbout, sendShowAbout } from "./show-about.ts";
import type { ShowAboutWindow } from "./show-about.ts";

function createMockWindow(options: {
  destroyed?: boolean;
  loading?: boolean;
  /** Flip loading to false inside `once` before the listener is stored (TOCTOU). */
  finishLoadDuringOnceRegister?: boolean;
}): ShowAboutWindow & {
  sent: string[];
  loadListeners: Array<() => void>;
  failListeners: Array<() => void>;
  setLoading: (loading: boolean) => void;
  destroy: () => void;
} {
  let destroyed = options.destroyed ?? false;
  let loading = options.loading ?? false;
  const sent: string[] = [];
  const loadListeners: Array<() => void> = [];
  const failListeners: Array<() => void> = [];

  return {
    sent,
    loadListeners,
    failListeners,
    setLoading(next) {
      loading = next;
    },
    destroy() {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
    webContents: {
      isLoading: () => loading,
      send(channel: string) {
        sent.push(channel);
      },
      once(event: "did-finish-load" | "did-fail-load", listener: () => void) {
        if (options.finishLoadDuringOnceRegister && event === "did-finish-load") {
          loading = false;
        }
        if (event === "did-finish-load") {
          loadListeners.push(listener);
        } else if (event === "did-fail-load") {
          failListeners.push(listener);
        }
      },
    },
  };
}

describe("sendShowAbout", () => {
  test("sends immediately when the window is not loading", () => {
    const window = createMockWindow({ loading: false });
    sendShowAbout(window);
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);
    expect(window.loadListeners).toHaveLength(0);
  });

  test("defers delivery until did-finish-load when loading", () => {
    const window = createMockWindow({ loading: true });
    sendShowAbout(window);
    expect(window.sent).toEqual([]);
    expect(window.loadListeners).toHaveLength(1);
    expect(window.failListeners).toHaveLength(1);

    window.setLoading(false);
    window.loadListeners[0]?.();
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);
  });

  test("delivers on did-fail-load and clears pending for a retry path", () => {
    const window = createMockWindow({ loading: true });
    sendShowAbout(window);
    expect(window.sent).toEqual([]);
    expect(window.failListeners).toHaveLength(1);

    window.setLoading(false);
    window.failListeners[0]?.();
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);

    // Pending cleared: a later finish-load listener must not double-send.
    window.loadListeners[0]?.();
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);

    // A fresh click while loading can enqueue deferred delivery again.
    window.setLoading(true);
    window.sent.length = 0;
    sendShowAbout(window);
    expect(window.loadListeners).toHaveLength(2);
    expect(window.failListeners).toHaveLength(2);
  });

  test("delivers immediately when load finishes before listener attaches (TOCTOU)", () => {
    const window = createMockWindow({ loading: true, finishLoadDuringOnceRegister: true });
    sendShowAbout(window);
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);
    expect(window.loadListeners).toHaveLength(1);
    expect(window.failListeners).toHaveLength(1);

    // Settled listeners must not double-send after the re-check delivered.
    window.loadListeners[0]?.();
    window.failListeners[0]?.();
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);
  });

  test("queues at most one deferred delivery per window", () => {
    const window = createMockWindow({ loading: true });
    sendShowAbout(window);
    sendShowAbout(window);
    sendShowAbout(window);
    expect(window.loadListeners).toHaveLength(1);
    expect(window.failListeners).toHaveLength(1);

    window.setLoading(false);
    for (const listener of window.loadListeners) {
      listener();
    }
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);
  });

  test("no-ops when the window is destroyed before delivery", () => {
    const window = createMockWindow({ loading: true });
    sendShowAbout(window);
    window.destroy();
    window.loadListeners[0]?.();
    expect(window.sent).toEqual([]);
  });

  test("sends immediately if load finished between clicks", () => {
    const window = createMockWindow({ loading: true });
    sendShowAbout(window);
    expect(window.loadListeners).toHaveLength(1);

    // Load completed; a second click should deliver immediately.
    window.setLoading(false);
    sendShowAbout(window);
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);

    // The deferred listener from the first click should not double-send:
    // pending flag was cleared by the immediate deliver.
    window.loadListeners[0]?.();
    expect(window.sent).toEqual([IPC_CHANNELS.showAbout]);
  });
});

describe("notifyShowAbout", () => {
  test("uses the focused window when present", () => {
    const focused = createMockWindow({ loading: false });
    const other = createMockWindow({ loading: false });
    notifyShowAbout({
      getFocusedWindow: () => focused,
      getAllWindows: () => [other, focused],
    });
    expect(focused.sent).toEqual([IPC_CHANNELS.showAbout]);
    expect(other.sent).toEqual([]);
  });

  test("falls back to the first open window when none is focused", () => {
    const first = createMockWindow({ loading: false });
    notifyShowAbout({
      getFocusedWindow: () => null,
      getAllWindows: () => [first],
    });
    expect(first.sent).toEqual([IPC_CHANNELS.showAbout]);
  });

  test("creates a window when none exist", () => {
    const created = createMockWindow({ loading: false });
    let createCalls = 0;
    notifyShowAbout({
      getFocusedWindow: () => null,
      getAllWindows: () => [],
      createWindow: () => {
        createCalls += 1;
        return created;
      },
    });
    expect(createCalls).toBe(1);
    expect(created.sent).toEqual([IPC_CHANNELS.showAbout]);
  });

  test("creates a window when the only window is destroyed", () => {
    const destroyed = createMockWindow({ destroyed: true });
    const created = createMockWindow({ loading: false });
    notifyShowAbout({
      getFocusedWindow: () => destroyed,
      getAllWindows: () => [destroyed],
      createWindow: () => created,
    });
    expect(created.sent).toEqual([IPC_CHANNELS.showAbout]);
    expect(destroyed.sent).toEqual([]);
  });

  test("prefers a live window when the focused window is destroyed", () => {
    const destroyed = createMockWindow({ destroyed: true });
    const live = createMockWindow({ loading: false });
    let createCalls = 0;
    notifyShowAbout({
      getFocusedWindow: () => destroyed,
      getAllWindows: () => [destroyed, live],
      createWindow: () => {
        createCalls += 1;
        return createMockWindow({ loading: false });
      },
    });
    expect(createCalls).toBe(0);
    expect(live.sent).toEqual([IPC_CHANNELS.showAbout]);
    expect(destroyed.sent).toEqual([]);
  });

  test("skips destroyed windows when falling back from an unfocused state", () => {
    const destroyed = createMockWindow({ destroyed: true });
    const live = createMockWindow({ loading: false });
    notifyShowAbout({
      getFocusedWindow: () => null,
      getAllWindows: () => [destroyed, live],
    });
    expect(live.sent).toEqual([IPC_CHANNELS.showAbout]);
    expect(destroyed.sent).toEqual([]);
  });

  test("no-ops when no windows exist and createWindow is unavailable", () => {
    expect(() =>
      notifyShowAbout({
        getFocusedWindow: () => null,
        getAllWindows: () => [],
      }),
    ).not.toThrow();
  });
});
