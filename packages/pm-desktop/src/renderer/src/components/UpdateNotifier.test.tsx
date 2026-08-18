import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { UpdateStatus } from "../../../shared/auto-update.ts";
import type { IpcResult, PmDesktopApi } from "../../../shared/ipc-contract.ts";
import type { QueryClient } from "@tanstack/react-query";
import { qk } from "../queries/keys.ts";
import { createTestQueryClient, withQueryClient } from "../test-helpers/query-client.tsx";
import { formatAboutUpdateResult } from "./AboutDialog.tsx";

mock.module("@/components/ui/dialog", () => {
  const React = require("react");
  const passthrough = (Tag: "div" | "h2") => {
    function DialogPassthrough({
      children,
      asChild: _asChild,
      ...props
    }: {
      children?: ReactNode;
      asChild?: boolean;
      [key: string]: unknown;
    }) {
      return React.createElement(Tag, props, children);
    }
    DialogPassthrough.displayName = `DialogPassthrough(${Tag})`;
    return DialogPassthrough;
  };

  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? React.createElement("div", { "data-testid": "dialog-root" }, children) : null,
    DialogTrigger: passthrough("div"),
    DialogPortal: passthrough("div"),
    DialogClose: passthrough("div"),
    DialogOverlay: passthrough("div"),
    DialogContent: passthrough("div"),
    DialogHeader: passthrough("div"),
    DialogFooter: passthrough("div"),
    DialogTitle: passthrough("h2"),
    DialogDescription: passthrough("div"),
  };
});

mock.module("@/components/ui/alert", () => {
  const React = require("react");
  return {
    Alert: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      React.createElement("div", props, children),
    AlertTitle: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      React.createElement("div", props, children),
    AlertDescription: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      React.createElement("div", props, children),
    // Keep export surface aligned with ui/alert so later suites that import
    // AlertAction aren't broken by mock.module.
    AlertAction: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      React.createElement("div", props, children),
  };
});

mock.module("@/components/ui/button", () => {
  const React = require("react");
  return {
    Button: ({
      children,
      onClick,
      disabled,
      ...props
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      [key: string]: unknown;
    }) => React.createElement("button", { type: "button", onClick, disabled, ...props }, children),
  };
});

const { formatDownloadLabel, shouldShowUpdateDialog, UpdateNotifier } =
  await import("./UpdateNotifier.tsx");
const { ReleaseNotes } = await import("./ReleaseNotes.tsx");

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

/** Drain the microtask queue enough to settle TanStack Query fetch + render. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("shouldShowUpdateDialog", () => {
  const base: UpdateStatus = { phase: "idle", currentVersion: "0.2.0" };

  test("hides disabled and idle states", () => {
    expect(
      shouldShowUpdateDialog({ ...base, phase: "disabled", disabledReason: "not-packaged" }),
    ).toBe(false);
    expect(shouldShowUpdateDialog(base)).toBe(false);
    expect(shouldShowUpdateDialog({ ...base, phase: "not-available" })).toBe(false);
  });

  test("shows available/downloaded unless snoozed", () => {
    expect(
      shouldShowUpdateDialog({
        ...base,
        phase: "available",
        availableVersion: "0.3.0",
      }),
    ).toBe(true);
    expect(
      shouldShowUpdateDialog({
        ...base,
        phase: "available",
        availableVersion: "0.3.0",
        snoozed: true,
      }),
    ).toBe(false);
    expect(
      shouldShowUpdateDialog({
        ...base,
        phase: "downloaded",
        availableVersion: "0.3.0",
      }),
    ).toBe(true);
  });

  test("always shows downloading and errors with a message", () => {
    expect(shouldShowUpdateDialog({ ...base, phase: "downloading" })).toBe(true);
    expect(shouldShowUpdateDialog({ ...base, phase: "error", errorMessage: "offline" })).toBe(true);
  });

  test("hides background download progress while snoozed", () => {
    expect(
      shouldShowUpdateDialog({
        ...base,
        phase: "downloading",
        snoozed: true,
        download: { percent: 42, transferred: 4, total: 10 },
      }),
    ).toBe(false);
  });
});

describe("formatDownloadLabel", () => {
  test("includes percent when present", () => {
    expect(
      formatDownloadLabel({
        phase: "downloading",
        currentVersion: "0.2.0",
        download: { percent: 42.7, transferred: 1, total: 2 },
      }),
    ).toBe("Downloading update… 42%");
  });
});

describe("formatAboutUpdateResult", () => {
  test("covers common phases", () => {
    expect(
      formatAboutUpdateResult({
        phase: "disabled",
        currentVersion: "0.2.0",
        disabledReason: "not-packaged",
      }),
    ).toContain("development");
    expect(
      formatAboutUpdateResult({
        phase: "not-available",
        currentVersion: "0.2.0",
      }),
    ).toBe("You're up to date.");
    expect(
      formatAboutUpdateResult({
        phase: "available",
        currentVersion: "0.2.0",
        availableVersion: "0.3.0",
      }),
    ).toContain("0.3.0");
  });
});

describe("UpdateNotifier against fake window.pm", () => {
  let domWindow: Window;
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let getUpdateStatus: ReturnType<typeof mock>;
  let downloadUpdate: ReturnType<typeof mock>;
  let snoozeUpdate: ReturnType<typeof mock>;
  let installUpdate: ReturnType<typeof mock>;
  let dismissUpdateError: ReturnType<typeof mock>;
  let checkForUpdates: ReturnType<typeof mock>;
  let openExternal: ReturnType<typeof mock>;

  const available: UpdateStatus = {
    phase: "available",
    currentVersion: "0.2.0",
    availableVersion: "0.3.0",
    releaseNotes: "Bug fixes",
    snoozed: false,
  };

  beforeEach(() => {
    domWindow = new Window();
    const { document } = domWindow;
    globalThis.document = document as unknown as Document;
    globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

    downloadUpdate = mock(async () => ok({ ...available, phase: "downloading" as const }));
    snoozeUpdate = mock(async () => ok({ ...available, snoozed: true }));
    installUpdate = mock(async () => ok({ ...available, phase: "downloaded" as const }));
    dismissUpdateError = mock(async () => ok(available));
    checkForUpdates = mock(async () => ok(available));
    openExternal = mock(async () => ok(null));
    getUpdateStatus = mock(async () => ok(available));

    const pm = {
      getUpdateStatus,
      onUpdateStatus: mock(() => () => {}),
      downloadUpdate,
      snoozeUpdate,
      installUpdate,
      dismissUpdateError,
      checkForUpdates,
      openExternal,
    } as unknown as PmDesktopApi;
    (domWindow as unknown as { pm: PmDesktopApi }).pm = pm;
    (globalThis.window as unknown as { pm: PmDesktopApi }).pm = pm;

    container = document.createElement("div") as unknown as HTMLDivElement;
    document.body.appendChild(
      container as unknown as Parameters<typeof document.body.appendChild>[0],
    );
    root = createRoot(container);
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    queryClient.unmount();
    container.remove();
    // @ts-expect-error test teardown
    delete globalThis.document;
    // @ts-expect-error test teardown
    delete globalThis.window;
    domWindow.close();
  });

  test("renders banner and drives install / later via preload API", async () => {
    queryClient.setQueryData(qk.updateStatus, available);

    await act(async () => {
      root.render(
        withQueryClient(createElement(UpdateNotifier, { hasBusyWork: false }), queryClient),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(domWindow.document.querySelector('[data-testid="update-notifier"]')).not.toBeNull();
    expect(
      domWindow.document.querySelector('[data-testid="update-notifier-title"]')?.textContent,
    ).toBe("Update available");

    const install = domWindow.document.querySelector(
      '[data-testid="update-notifier-install"]',
    ) as HTMLButtonElement | null;
    expect(install).not.toBeNull();
    await act(async () => {
      install!.click();
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(downloadUpdate).toHaveBeenCalledTimes(1);

    // downloadUpdate resolved with `downloading`, which the component wrote
    // back into the cache via setQueryData — re-seed `available` so the Later
    // button is interactive again (downloading disables the action buttons).
    await act(async () => {
      queryClient.setQueryData(qk.updateStatus, available);
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const later = domWindow.document.querySelector(
      '[data-testid="update-notifier-later"]',
    ) as HTMLButtonElement | null;
    expect(later).not.toBeNull();
    await act(async () => {
      later!.click();
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(snoozeUpdate).toHaveBeenCalledTimes(1);
  });

  test("renders formatted release notes and opens safe links without native navigation", async () => {
    const notesStatus: UpdateStatus = {
      ...available,
      releaseNotes: `
        <h2 onclick="alert('nope')">Highlights</h2>
        <p>Fixed <strong>ticket sync</strong>.
        <ul><li>Faster startup</li></ul>
        <a href="https://example.com/releases/0.3.0" onmouseover="alert('nope')">Full notes</a>
        <a href="javascript:alert('nope')">Unsafe link</a>
        <script>window.pwned = true</script>
        <img src="https://tracker.invalid/pixel" onerror="alert('nope')">
        <iframe src="https://example.com">embedded content</iframe>
      `,
    };
    getUpdateStatus.mockImplementation(async () => ok(notesStatus));
    queryClient.setQueryData(qk.updateStatus, notesStatus);

    await act(async () => {
      root.render(
        withQueryClient(createElement(UpdateNotifier, { hasBusyWork: false }), queryClient),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const notes = domWindow.document.querySelector('[data-testid="update-notifier-notes"]');
    expect(notes?.querySelector("h2")?.textContent).toBe("Highlights");
    expect(notes?.querySelector("strong")?.textContent).toBe("ticket sync");
    expect(notes?.querySelector("li")?.textContent).toBe("Faster startup");
    expect(notes?.querySelector("script, img, iframe")).toBeNull();
    expect(notes?.textContent).not.toContain("window.pwned");
    expect(notes?.textContent).not.toContain("embedded content");

    const links = notes?.querySelectorAll("button");
    expect(links?.length).toBe(1);
    expect(notes?.querySelector("a")).toBeNull();
    expect(notes?.textContent).toContain("Unsafe link");
    expect(links?.[0]?.getAttribute("onclick")).toBeNull();
    expect(links?.[0]?.getAttribute("onmouseover")).toBeNull();
    expect(links?.[0]?.getAttribute("type")).toBe("button");

    const safeLink = links?.[0];
    if (!safeLink) throw new Error("Expected a safe release-note link");
    await act(async () => {
      safeLink.click();
      await flushMicrotasks();
    });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/releases/0.3.0");
  });

  test("shows a fallback when release notes are missing or fully removed", async () => {
    const missingNotesStatus: UpdateStatus = { ...available, releaseNotes: undefined };
    getUpdateStatus.mockImplementation(async () => ok(missingNotesStatus));
    queryClient.setQueryData(qk.updateStatus, missingNotesStatus);

    await act(async () => {
      root.render(
        withQueryClient(createElement(UpdateNotifier, { hasBusyWork: false }), queryClient),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(
      domWindow.document.querySelector('[data-testid="update-notifier-notes"]')?.textContent,
    ).toBe("Release notes are unavailable.");

    const unsafeNotesStatus: UpdateStatus = {
      ...available,
      releaseNotes: "<script>alert('nope')</script><img src=x><iframe>hidden</iframe>",
    };
    await act(async () => {
      queryClient.setQueryData(qk.updateStatus, unsafeNotesStatus);
      await flushMicrotasks();
    });

    expect(
      domWindow.document.querySelector('[data-testid="update-notifier-notes"]')?.textContent,
    ).toBe("Release notes are unavailable.");
    expect(
      domWindow.document.querySelector('[data-testid="update-notifier-install"]'),
    ).not.toBeNull();
    expect(
      domWindow.document.querySelector('[data-testid="update-notifier-later"]'),
    ).not.toBeNull();
  });

  test("bounds release-note input size, nesting depth, and rendered node count", async () => {
    await act(async () => {
      root.render(createElement(ReleaseNotes, { html: `<p>${"x".repeat(25_000)}</p>` }));
      await flushMicrotasks();
    });

    const notes = domWindow.document.querySelector('[data-testid="update-notifier-notes"]');
    expect(notes?.textContent).toBe("Release notes are unavailable.");

    await act(async () => {
      root.render(
        createElement(ReleaseNotes, {
          html: `${"<div>".repeat(30)}Deep${"</div>".repeat(30)}`,
        }),
      );
      await flushMicrotasks();
    });
    expect(notes?.textContent).toBe("Release notes are unavailable.");

    await act(async () => {
      root.render(createElement(ReleaseNotes, { html: "<i>x</i>".repeat(600) }));
      await flushMicrotasks();
    });
    expect(notes?.textContent).toBe("Release notes are unavailable.");
  });

  test("retry on error calls downloadUpdate when a version is available", async () => {
    const errorStatus: UpdateStatus = {
      phase: "error",
      currentVersion: "0.2.0",
      availableVersion: "0.3.0",
      errorMessage: "network down",
    };
    getUpdateStatus.mockImplementation(async () => ok(errorStatus));
    queryClient.setQueryData(qk.updateStatus, errorStatus);

    await act(async () => {
      root.render(
        withQueryClient(createElement(UpdateNotifier, { hasBusyWork: false }), queryClient),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(
      domWindow.document.querySelector('[data-testid="update-notifier-error"]')?.textContent,
    ).toBe("network down");

    const retry = domWindow.document.querySelector(
      '[data-testid="update-notifier-retry"]',
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.click();
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });
});
