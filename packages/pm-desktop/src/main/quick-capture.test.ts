import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC_CHANNELS } from "../shared/ipc-contract.ts";
import { DEFAULT_QUICK_CAPTURE_ACCELERATOR } from "../shared/quick-capture.ts";
import type { QuickCaptureEvent } from "../shared/quick-capture.ts";
import {
  deliverQuickCapture,
  getQuickCaptureStatus,
  initQuickCapture,
  invokeQuickCapture,
  setQuickCaptureSettings,
  syncQuickCaptureRegistration,
} from "./quick-capture.ts";
import type { GlobalShortcutLike, QuickCapturePorts, QuickCaptureWindow } from "./quick-capture.ts";
import { readSettings, setUserDataDirForTests } from "./settings.ts";

interface Harness {
  ports: QuickCapturePorts;
  registered: Map<string, () => void>;
  clipboardText: string;
  window: FakeWindow | null;
  createdWindows: FakeWindow[];
  appActivations: number;
}

class FakeWindow implements QuickCaptureWindow {
  destroyed = false;
  minimized = false;
  loading = false;
  sent: Array<{ channel: string; args: unknown[] }> = [];
  private loadListeners: Array<() => void> = [];
  shown = 0;
  focused = 0;
  // Stable per-window surface (mirrors Electron's webContents identity) so
  // concurrent deliveries target the same pending-delivery slot.
  private readonly webContentsApi = {
    isLoading: () => this.loading,
    send: (channel: string, ...args: unknown[]) => {
      this.sent.push({ channel, args });
    },
    once: (_event: "did-finish-load" | "did-fail-load", listener: () => void) => {
      this.loadListeners.push(listener);
    },
  };

  get webContents() {
    return this.webContentsApi;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {}
  show(): void {
    this.shown += 1;
  }
  focus(): void {
    this.focused += 1;
  }

  finishLoad(): void {
    this.loading = false;
    for (const listener of this.loadListeners.splice(0)) listener();
  }
}

function makeHarness(overrides?: Partial<Pick<Harness, "clipboardText">>): Harness {
  const harness: Harness = {
    registered: new Map(),
    clipboardText: overrides?.clipboardText ?? "",
    window: null,
    createdWindows: [],
    appActivations: 0,
    ports: null as unknown as QuickCapturePorts,
  };
  const globalShortcut: GlobalShortcutLike = {
    register: (accelerator, listener) => {
      if (harness.registered.has(accelerator)) return false;
      harness.registered.set(accelerator, listener);
      return true;
    },
    unregister: (accelerator) => {
      harness.registered.delete(accelerator);
    },
  };
  harness.window = new FakeWindow();
  harness.ports = {
    globalShortcut,
    readClipboardText: () => harness.clipboardText,
    getWindow: () => (harness.window && !harness.window.destroyed ? harness.window : null),
    createWindow: () => {
      const created = new FakeWindow();
      created.loading = true;
      harness.createdWindows.push(created);
      return created;
    },
    activateApp: () => {
      harness.appActivations += 1;
    },
  };
  return harness;
}

describe("quick capture registration", () => {
  let tempDir: string;
  let harness: Harness;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-quick-capture-"));
    setUserDataDirForTests(tempDir);
    harness = makeHarness();
    initQuickCapture(harness.ports);
  });

  afterEach(async () => {
    initQuickCapture(undefined);
    setUserDataDirForTests(undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("disabled by default: no hotkey registered", async () => {
    const status = await syncQuickCaptureRegistration();
    expect(status.enabled).toBe(false);
    expect(status.registered).toBe(false);
    expect(status.shortcut).toBe(DEFAULT_QUICK_CAPTURE_ACCELERATOR);
    expect(harness.registered.size).toBe(0);
  });

  test("enabling registers the resolved default accelerator", async () => {
    const status = await setQuickCaptureSettings({ enabled: true, shortcut: null });
    expect(status.enabled).toBe(true);
    expect(status.registered).toBe(true);
    expect(status.shortcut).toBe(DEFAULT_QUICK_CAPTURE_ACCELERATOR);
    expect(harness.registered.has(DEFAULT_QUICK_CAPTURE_ACCELERATOR)).toBe(true);
    expect((await readSettings()).quickCaptureEnabled).toBe(true);
  });

  test("disabling unregisters the hotkey", async () => {
    await setQuickCaptureSettings({ enabled: true, shortcut: null });
    const status = await setQuickCaptureSettings({ enabled: false, shortcut: null });
    expect(status.registered).toBe(false);
    expect(harness.registered.size).toBe(0);
  });

  test("conflicting registration reports an error instead of failing silently", async () => {
    // Another app already holds the default combination.
    harness.registered.set(DEFAULT_QUICK_CAPTURE_ACCELERATOR, () => {});
    const status = await setQuickCaptureSettings({ enabled: true, shortcut: null });
    expect(status.enabled).toBe(true);
    expect(status.registered).toBe(false);
    expect(status.error).toContain("another app");
    expect(await getQuickCaptureStatus()).toMatchObject({ registered: false });
  });

  test("changing the binding releases the previous accelerator", async () => {
    await setQuickCaptureSettings({ enabled: true, shortcut: null });
    const status = await setQuickCaptureSettings({ enabled: true, shortcut: "Ctrl+Alt+K" });
    expect(status.registered).toBe(true);
    expect(harness.registered.has(DEFAULT_QUICK_CAPTURE_ACCELERATOR)).toBe(false);
    expect(harness.registered.has("Ctrl+Alt+K")).toBe(true);
  });

  test("invalid custom accelerator shapes never register", async () => {
    const status = await setQuickCaptureSettings({ enabled: true, shortcut: "Not A Key!" });
    expect(status.registered).toBe(false);
    expect(status.error).toBeTruthy();
    expect(harness.registered.size).toBe(0);
  });

  test("status without ports stays inert", async () => {
    initQuickCapture(undefined);
    const status = await setQuickCaptureSettings({ enabled: true, shortcut: null });
    expect(status.enabled).toBe(true);
    expect(status.registered).toBe(false);
  });
});

describe("quick capture invocation + delivery", () => {
  let tempDir: string;
  let harness: Harness;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pm-desktop-quick-capture-invoke-"));
    setUserDataDirForTests(tempDir);
    harness = makeHarness();
    initQuickCapture(harness.ports);
    await setQuickCaptureSettings({ enabled: true, shortcut: null });
  });

  afterEach(async () => {
    initQuickCapture(undefined);
    setUserDataDirForTests(undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("figma URL on the clipboard lands as a figma capture", () => {
    harness.clipboardText = "https://www.figma.com/design/A1?node-id=2-3";
    invokeQuickCapture();
    const delivery = harness.window!.sent.at(-1)!;
    expect(delivery.channel).toBe(IPC_CHANNELS.quickCapture);
    const payload = delivery.args[0] as QuickCaptureEvent;
    expect(payload.sourceType).toBe("figma");
    expect(payload.text).toContain("figma.com");
  });

  test("empty clipboard delivers an empty prompt capture", () => {
    harness.clipboardText = "   ";
    invokeQuickCapture();
    const payload = harness.window!.sent.at(-1)!.args[0] as QuickCaptureEvent;
    expect(payload).toEqual({ text: null, sourceType: "prompt" });
  });

  test("delivery focuses the window even when nothing is captured", () => {
    invokeQuickCapture();
    expect(harness.window!.shown).toBe(1);
    expect(harness.window!.focused).toBe(1);
    // macOS-style app activation is requested on every invocation.
    expect(harness.appActivations).toBe(1);
  });

  test("no live window falls back to creating one and defers until loaded", () => {
    harness.window!.destroyed = true;
    invokeQuickCapture();
    expect(harness.createdWindows).toHaveLength(1);
    // Created windows start loading: payload waits for did-finish-load.
    expect(harness.createdWindows[0]!.sent).toHaveLength(0);
    harness.createdWindows[0]!.finishLoad();
    const payload = harness.createdWindows[0]!.sent[0]!.args[0] as QuickCaptureEvent;
    expect(payload.sourceType).toBe("prompt");
  });

  test("rapid captures during launch deliver only the newest clipboard snapshot", () => {
    // Same window, still loading: both hotkey presses race the page load.
    harness.window!.loading = true;
    harness.clipboardText = "stale capture";
    invokeQuickCapture();
    harness.clipboardText = "fresh capture";
    invokeQuickCapture();
    const window = harness.window!;
    expect(window.sent).toHaveLength(0);
    window.finishLoad();
    expect(window.sent).toHaveLength(1);
    const payload = window.sent[0]!.args[0] as QuickCaptureEvent;
    expect(payload.text).toBe("fresh capture");
  });

  test("minimized window is restored, shown, focused", () => {
    harness.window!.minimized = true;
    invokeQuickCapture();
    expect(harness.window!.sent).toHaveLength(1);
    expect(harness.window!.focused).toBe(1);
  });
});

describe("deliverQuickCapture", () => {
  const payload: QuickCaptureEvent = { text: "note", sourceType: "prompt" };

  function deps(window: FakeWindow | null) {
    return {
      getWindow: () => window,
      createWindow: () => null,
    };
  }

  test("sends immediately when the page is loaded", () => {
    const window = new FakeWindow();
    deliverQuickCapture(payload, deps(window));
    expect(window.sent).toHaveLength(1);
    expect(window.sent[0]!.channel).toBe(IPC_CHANNELS.quickCapture);
  });

  test("defers while loading and delivers exactly once", () => {
    const window = new FakeWindow();
    window.loading = true;
    deliverQuickCapture(payload, deps(window));
    expect(window.sent).toHaveLength(0);
    window.finishLoad();
    expect(window.sent).toHaveLength(1);
  });

  test("a second capture while loading overwrites the pending payload", () => {
    const window = new FakeWindow();
    window.loading = true;
    deliverQuickCapture({ text: "first", sourceType: "prompt" }, deps(window));
    deliverQuickCapture({ text: "second", sourceType: "log" }, deps(window));
    window.finishLoad();
    // Only the most recent snapshot is delivered — none are dropped silently.
    expect(window.sent).toHaveLength(1);
    expect(window.sent[0]!.args[0]).toEqual({ text: "second", sourceType: "log" });
  });

  test("captures arriving after load finishes are delivered immediately", () => {
    const window = new FakeWindow();
    window.loading = true;
    deliverQuickCapture({ text: "early", sourceType: "prompt" }, deps(window));
    window.finishLoad();
    deliverQuickCapture({ text: "late", sourceType: "prompt" }, deps(window));
    const texts = window.sent.map((delivery) => (delivery.args[0] as QuickCaptureEvent).text);
    expect(texts).toEqual(["early", "late"]);
  });

  test("does nothing without any window", () => {
    expect(() => deliverQuickCapture(payload, deps(null))).not.toThrow();
  });
});
