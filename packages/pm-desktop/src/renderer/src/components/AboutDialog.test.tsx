import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ABOUT_PRODUCT_NAME, ABOUT_WEBSITE_URL } from "../../../shared/about.ts";
import type { UpdateStatus } from "../../../shared/auto-update.ts";
import type { IpcResult, PmDesktopApi } from "../../../shared/ipc-contract.ts";
import type { QueryClient } from "@tanstack/react-query";
import { createTestQueryClient, withQueryClient } from "../test-helpers/query-client.tsx";
import { qk } from "../queries/keys.ts";

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
    // Keep the mock export surface aligned with ui/dialog so later suites that
    // import DialogTrigger/Portal/Close/Overlay aren't broken by mock.module.
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

const { ABOUT_VERSION_UNAVAILABLE, AboutDialog, formatAboutVersion } =
  await import("./AboutDialog.tsx");

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

/** Drain the microtask queue enough to settle TanStack Query fetch + render. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface PmApiOverrides {
  status: UpdateStatus;
  checkForUpdates?: ReturnType<typeof mock>;
}

/** Install a minimal `window.pm` for happy-dom AboutDialog tests. */
function installPmApi(domWindow: Window, overrides: PmApiOverrides): void {
  let _listener: ((status: UpdateStatus) => void) | undefined;
  const checkForUpdates = overrides.checkForUpdates ?? mock(async () => ok(overrides.status));
  const api = {
    getUpdateStatus: mock(async () => ok(overrides.status)),
    onUpdateStatus: mock((callback: (status: UpdateStatus) => void) => {
      _listener = callback;
      return () => {
        _listener = undefined;
      };
    }),
    checkForUpdates,
  } as unknown as PmDesktopApi;
  (domWindow as unknown as { pm: PmDesktopApi }).pm = api;
  (globalThis.window as unknown as { pm: PmDesktopApi }).pm = api;
}

describe("formatAboutVersion", () => {
  test("includes the installed version when available", () => {
    expect(formatAboutVersion("0.2.0")).toBe("Version 0.2.0");
  });

  test("shows a loading placeholder when version is not yet available", () => {
    expect(formatAboutVersion(null)).toBe("Version …");
  });

  test("shows unavailable when version IPC failed", () => {
    expect(formatAboutVersion(ABOUT_VERSION_UNAVAILABLE)).toBe("Version unavailable");
  });
});

describe("AboutDialog", () => {
  function renderAbout(
    props: Partial<{
      open: boolean;
      version: string | null;
      onOpenWebsite: (url: string) => void;
    }> = {},
  ): string {
    return renderToStaticMarkup(
      withQueryClient(
        createElement(AboutDialog, {
          open: props.open ?? true,
          onOpenChange: () => {},
          version: props.version ?? "0.2.0",
          onOpenWebsite: props.onOpenWebsite ?? (() => {}),
        }),
      ),
    );
  }

  test("renders title, app name, version, and website control when open", () => {
    const html = renderAbout({ version: "1.0.0" });
    expect(html).toContain('data-testid="about-dialog"');
    expect(html).toContain('data-testid="about-dialog-title"');
    expect(html).toContain(`About ${ABOUT_PRODUCT_NAME}`);
    expect(html).toContain('data-testid="about-dialog-app-name"');
    expect(html).toContain("devintern");
    expect(html).toContain(">pm<");
    expect(html).not.toContain("DevIntern PM");
    expect(html).toContain('data-testid="about-dialog-version"');
    expect(html).toContain("Version 1.0.0");
    expect(html).toContain('data-testid="about-dialog-website"');
    expect(html).toContain("Visit website");
    expect(html).toContain('data-testid="about-dialog-check-updates"');
    expect(html).toContain("Check for updates");
    expect(html).toContain('data-testid="about-dialog-close"');
  });

  describe("website button", () => {
    let domWindow: Window;
    let container: HTMLDivElement;
    let root: Root;
    let queryClient: QueryClient;

    beforeEach(() => {
      domWindow = new Window();
      const { document } = domWindow;
      globalThis.document = document as unknown as Document;
      globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

    test("calls onOpenWebsite with the public homepage URL", async () => {
      installPmApi(domWindow, { status: { phase: "idle", currentVersion: "0.2.0" } });
      const onOpenWebsite = mock(() => {});
      await act(async () => {
        root.render(
          withQueryClient(
            createElement(AboutDialog, {
              open: true,
              onOpenChange: () => {},
              version: "0.2.0",
              onOpenWebsite,
            }),
            queryClient,
          ),
        );
        await flushMicrotasks();
      });

      const button = domWindow.document.querySelector('[data-testid="about-dialog-website"]');
      expect(button).not.toBeNull();
      await act(async () => {
        button!.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
      });

      expect(onOpenWebsite).toHaveBeenCalledTimes(1);
      expect(onOpenWebsite).toHaveBeenCalledWith(ABOUT_WEBSITE_URL);
    });
  });

  describe("live update status", () => {
    let domWindow: Window;
    let container: HTMLDivElement;
    let root: Root;
    let queryClient: QueryClient;
    let checkForUpdates: ReturnType<typeof mock>;

    beforeEach(() => {
      domWindow = new Window();
      const { document } = domWindow;
      globalThis.document = document as unknown as Document;
      globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

      container = document.createElement("div") as unknown as HTMLDivElement;
      document.body.appendChild(
        container as unknown as Parameters<typeof document.body.appendChild>[0],
      );
      root = createRoot(container);
      queryClient = createTestQueryClient();
      checkForUpdates = mock(async () => ok({ phase: "not-available", currentVersion: "0.2.0" }));
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

    test("surfaces a known available update immediately on open without a manual check", async () => {
      const available: UpdateStatus = {
        phase: "available",
        currentVersion: "0.2.0",
        availableVersion: "0.3.0",
        releaseNotes: "Bug fixes",
        snoozed: false,
      };
      installPmApi(domWindow, { status: available, checkForUpdates });
      queryClient.setQueryData(qk.updateStatus, available);

      await act(async () => {
        root.render(
          withQueryClient(
            createElement(AboutDialog, {
              open: true,
              onOpenChange: () => {},
              version: "0.2.0",
              onOpenWebsite: () => {},
            }),
            queryClient,
          ),
        );
        await flushMicrotasks();
      });
      // Let the seed effect run + re-render with the update message.
      await act(async () => {
        await flushMicrotasks();
      });

      expect(
        domWindow.document.querySelector('[data-testid="about-dialog-update-result"]')?.textContent,
      ).toContain("0.3.0");
      // No manual check was triggered just by opening.
      expect(checkForUpdates).not.toHaveBeenCalled();
    });

    test("disables Check for updates and shows the dev message in unpackaged builds", async () => {
      const status: UpdateStatus = {
        phase: "disabled",
        currentVersion: "0.2.0",
        disabledReason: "not-packaged",
      };
      installPmApi(domWindow, { status, checkForUpdates });
      queryClient.setQueryData(qk.updateStatus, status);

      await act(async () => {
        root.render(
          withQueryClient(
            createElement(AboutDialog, {
              open: true,
              onOpenChange: () => {},
              version: "0.2.0",
              onOpenWebsite: () => {},
            }),
            queryClient,
          ),
        );
        await flushMicrotasks();
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const button = domWindow.document.querySelector(
        '[data-testid="about-dialog-check-updates"]',
      ) as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(true);
      expect(
        domWindow.document.querySelector('[data-testid="about-dialog-update-result"]')?.textContent,
      ).toContain("development builds");
      // Clicking a disabled button must not attempt a check.
      expect(checkForUpdates).not.toHaveBeenCalled();
    });

    test("a manual check overrides the seeded message", async () => {
      const available: UpdateStatus = {
        phase: "available",
        currentVersion: "0.2.0",
        availableVersion: "0.3.0",
        snoozed: false,
      };
      installPmApi(domWindow, { status: available, checkForUpdates });
      queryClient.setQueryData(qk.updateStatus, available);

      await act(async () => {
        root.render(
          withQueryClient(
            createElement(AboutDialog, {
              open: true,
              onOpenChange: () => {},
              version: "0.2.0",
              onOpenWebsite: () => {},
            }),
            queryClient,
          ),
        );
        await flushMicrotasks();
      });
      await act(async () => {
        await flushMicrotasks();
      });

      expect(
        domWindow.document.querySelector('[data-testid="about-dialog-update-result"]')?.textContent,
      ).toContain("0.3.0");

      const button = domWindow.document.querySelector(
        '[data-testid="about-dialog-check-updates"]',
      ) as HTMLButtonElement | null;
      await act(async () => {
        button!.click();
        await flushMicrotasks();
      });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
      expect(
        domWindow.document.querySelector('[data-testid="about-dialog-update-result"]')?.textContent,
      ).toContain("up to date");
    });
  });
});
