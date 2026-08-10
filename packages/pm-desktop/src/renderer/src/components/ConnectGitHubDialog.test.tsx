import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IpcResult, PmDesktopApi, ProjectStatus } from "../../../shared/ipc-contract.ts";

mock.module("@/components/ui/dialog", () => {
  const React = require("react");
  const passthrough =
    (Tag: "div" | "h2") =>
    ({
      children,
      asChild: _asChild,
      ...props
    }: {
      children?: ReactNode;
      asChild?: boolean;
      [key: string]: unknown;
    }) =>
      React.createElement(Tag, props, children);

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

const { ConnectGitHubDialog } = await import("./ConnectGitHubDialog.tsx");

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function err(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

const sampleStatus: ProjectStatus = {
  projectDir: "/data/projects/acme-web",
  configured: false,
  isGitRepository: true,
  configuredTrackers: [],
};

describe("ConnectGitHubDialog", () => {
  let domWindow: Window;
  let container: HTMLDivElement;
  let root: Root;
  let getGitHubAuthStatus: ReturnType<typeof mock>;
  let isGitHubOAuthAvailable: ReturnType<typeof mock>;
  let startGitHubOAuth: ReturnType<typeof mock>;
  let cancelGitHubOAuth: ReturnType<typeof mock>;
  let onGitHubOAuthPrompt: ReturnType<typeof mock>;
  let openExternal: ReturnType<typeof mock>;
  let listGitHubRepos: ReturnType<typeof mock>;
  let connectGitHubRepo: ReturnType<typeof mock>;
  let setGitHubToken: ReturnType<typeof mock>;
  let onConnected: ReturnType<typeof mock>;
  let onOpenChange: ReturnType<typeof mock>;

  beforeEach(() => {
    domWindow = new Window();
    const { document } = domWindow;
    globalThis.document = document as unknown as Document;
    globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

    getGitHubAuthStatus = mock(async () => ok({ connected: false, encryptionAvailable: true }));
    isGitHubOAuthAvailable = mock(async () => ok(true));
    startGitHubOAuth = mock(async () =>
      ok({
        connected: true,
        method: "oauth",
        login: "dana",
        encryptionAvailable: true,
        tokenEncrypted: true,
      }),
    );
    cancelGitHubOAuth = mock(async () => ok(null));
    onGitHubOAuthPrompt = mock(() => () => {});
    openExternal = mock(async () => ok(null));
    listGitHubRepos = mock(async () => ok([]));
    connectGitHubRepo = mock(async () => ok(sampleStatus));
    setGitHubToken = mock(async () =>
      ok({
        connected: true,
        method: "pat",
        login: "dana",
        encryptionAvailable: true,
        tokenEncrypted: true,
      }),
    );
    onConnected = mock(() => {});
    onOpenChange = mock(() => {});

    const pm = {
      getGitHubAuthStatus,
      isGitHubOAuthAvailable,
      startGitHubOAuth,
      cancelGitHubOAuth,
      onGitHubOAuthPrompt,
      openExternal,
      listGitHubRepos,
      connectGitHubRepo,
      setGitHubToken,
    } as unknown as PmDesktopApi;
    (domWindow as unknown as { pm: PmDesktopApi }).pm = pm;
    (globalThis.window as unknown as { pm: PmDesktopApi }).pm = pm;

    container = document.createElement("div") as unknown as HTMLDivElement;
    document.body.appendChild(
      container as unknown as Parameters<typeof document.body.appendChild>[0],
    );
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // @ts-expect-error test teardown
    delete globalThis.document;
    // @ts-expect-error test teardown
    delete globalThis.window;
    domWindow.close();
  });

  async function renderOpen(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(ConnectGitHubDialog, {
          open: true,
          onOpenChange,
          onConnected,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  test("shows Sign in with GitHub when auth is required and OAuth is available", async () => {
    await renderOpen();
    expect(domWindow.document.querySelector('[data-testid="connect-github-oauth"]')).not.toBeNull();
    expect(
      domWindow.document.querySelector('[data-testid="connect-github-sign-in"]'),
    ).not.toBeNull();
    expect(domWindow.document.querySelector('[data-testid="connect-github-auth-ok"]')).toBeNull();
  });

  test("falls back to PAT field when OAuth is unavailable", async () => {
    isGitHubOAuthAvailable.mockImplementation(async () => ok(false));
    await renderOpen();
    expect(domWindow.document.querySelector('[data-testid="connect-github-oauth"]')).toBeNull();
    expect(domWindow.document.querySelector('[data-testid="connect-github-token"]')).not.toBeNull();
  });

  test("displays the device-flow user code when the prompt arrives", async () => {
    let promptCallback: ((prompt: { userCode: string; verificationUri: string }) => void) | null =
      null;
    onGitHubOAuthPrompt.mockImplementation((cb) => {
      promptCallback = cb;
      return () => {};
    });
    // Keep the sign-in promise pending so the code block stays visible.
    let resolveSignIn: (
      value: IpcResult<{
        connected: boolean;
        method: "oauth";
        login: string;
        encryptionAvailable: boolean;
        tokenEncrypted: boolean;
      }>,
    ) => void = () => {};
    startGitHubOAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignIn = resolve;
        }),
    );

    await renderOpen();

    const signIn = domWindow.document.querySelector(
      '[data-testid="connect-github-sign-in"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      signIn!.click();
      await Promise.resolve();
    });

    // Simulate the main process broadcasting the prompt.
    await act(async () => {
      promptCallback?.({ userCode: "AB-CDEF", verificationUri: "https://github.com/login/device" });
      await Promise.resolve();
    });

    const codeEl = domWindow.document.querySelector('[data-testid="connect-github-user-code"]');
    expect(codeEl?.textContent).toBe("AB-CDEF");
    expect(
      domWindow.document.querySelector('[data-testid="connect-github-copy-code"]'),
    ).not.toBeNull();

    // Clean up: resolve the pending sign-in.
    resolveSignIn(
      ok({
        connected: true,
        method: "oauth",
        login: "dana",
        encryptionAvailable: true,
        tokenEncrypted: true,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  test("Sign in with GitHub triggers startGitHubOAuth then loads repos", async () => {
    listGitHubRepos.mockImplementation(async () =>
      ok([{ fullName: "acme/web", private: false, defaultBranch: "main" }]),
    );

    await renderOpen();

    const signIn = domWindow.document.querySelector(
      '[data-testid="connect-github-sign-in"]',
    ) as HTMLButtonElement | null;
    expect(signIn).not.toBeNull();
    await act(async () => {
      signIn!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(startGitHubOAuth).toHaveBeenCalledTimes(1);
    expect(
      domWindow.document.querySelector('[data-testid="connect-github-auth-ok"]'),
    ).not.toBeNull();
  });

  test("repo pick from list and successful connect callback", async () => {
    getGitHubAuthStatus.mockImplementation(async () =>
      ok({
        connected: true,
        method: "oauth",
        login: "dana",
        encryptionAvailable: true,
        tokenEncrypted: true,
      }),
    );
    listGitHubRepos.mockImplementation(async () =>
      ok([
        {
          fullName: "acme/web",
          private: false,
          defaultBranch: "main",
        },
      ]),
    );

    await renderOpen();

    expect(
      domWindow.document.querySelector('[data-testid="connect-github-auth-ok"]'),
    ).not.toBeNull();
    const list = domWindow.document.querySelector('[data-testid="connect-github-repo-list"]');
    expect(list).not.toBeNull();

    const pick = list!.querySelector("button") as HTMLButtonElement | null;
    expect(pick).not.toBeNull();
    await act(async () => {
      pick!.click();
      await Promise.resolve();
    });

    const repoInput = domWindow.document.querySelector(
      '[data-testid="connect-github-repo"]',
    ) as HTMLInputElement | null;
    expect(repoInput?.value).toBe("acme/web");

    const branchInput = domWindow.document.querySelector(
      '[data-testid="connect-github-branch"]',
    ) as HTMLInputElement | null;
    expect(branchInput?.value).toBe("");

    const submit = domWindow.document.querySelector(
      '[data-testid="connect-github-submit"]',
    ) as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    await act(async () => {
      submit!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(connectGitHubRepo).toHaveBeenCalledTimes(1);
    expect(connectGitHubRepo.mock.calls[0]?.[0]).toEqual({
      repoInput: "acme/web",
      branch: undefined,
    });
    expect(onConnected).toHaveBeenCalledWith(sampleStatus);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("list pick does not force defaultBranch so reconnect can keep checkout", async () => {
    getGitHubAuthStatus.mockImplementation(async () =>
      ok({ connected: true, method: "oauth", encryptionAvailable: true, tokenEncrypted: true }),
    );
    listGitHubRepos.mockImplementation(async () =>
      ok([
        {
          fullName: "acme/web",
          private: false,
          defaultBranch: "main",
        },
      ]),
    );

    await renderOpen();

    const pick = domWindow.document
      .querySelector('[data-testid="connect-github-repo-list"]')
      ?.querySelector("button") as HTMLButtonElement | null;
    expect(pick).not.toBeNull();
    await act(async () => {
      pick!.click();
      await Promise.resolve();
    });

    const branchInput = domWindow.document.querySelector(
      '[data-testid="connect-github-branch"]',
    ) as HTMLInputElement | null;
    expect(branchInput?.value).toBe("");

    const submit = domWindow.document.querySelector(
      '[data-testid="connect-github-submit"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      submit!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(connectGitHubRepo.mock.calls[0]?.[0]).toEqual({
      repoInput: "acme/web",
      branch: undefined,
    });
  });

  test("surfaces auth_required error and shows auth block", async () => {
    getGitHubAuthStatus.mockImplementation(async () =>
      ok({ connected: true, method: "oauth", encryptionAvailable: true, tokenEncrypted: true }),
    );
    listGitHubRepos.mockImplementation(async () =>
      ok([
        {
          fullName: "acme/private",
          private: true,
          defaultBranch: "main",
        },
      ]),
    );
    connectGitHubRepo.mockImplementation(async () =>
      err("auth_required", "Connect a token with access to this repository."),
    );

    await renderOpen();

    const pick = domWindow.document
      .querySelector('[data-testid="connect-github-repo-list"]')
      ?.querySelector("button") as HTMLButtonElement | null;
    expect(pick).not.toBeNull();
    await act(async () => {
      pick!.click();
      await Promise.resolve();
    });

    const submit = domWindow.document.querySelector(
      '[data-testid="connect-github-submit"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      submit!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const error = domWindow.document.querySelector('[data-testid="connect-github-error"]');
    expect(error?.textContent).toContain("Connect a token");
    expect(domWindow.document.querySelector('[data-testid="connect-github-auth"]')).not.toBeNull();
  });

  test("surfaces forbidden listRepos error", async () => {
    getGitHubAuthStatus.mockImplementation(async () =>
      ok({ connected: true, method: "oauth", encryptionAvailable: true, tokenEncrypted: true }),
    );
    listGitHubRepos.mockImplementation(async () =>
      err("forbidden", "Token does not have access to list repositories."),
    );

    await renderOpen();

    const error = domWindow.document.querySelector('[data-testid="connect-github-error"]');
    expect(error?.textContent).toContain("does not have access");
    expect(domWindow.document.querySelector('[data-testid="connect-github-auth"]')).not.toBeNull();
  });
});
