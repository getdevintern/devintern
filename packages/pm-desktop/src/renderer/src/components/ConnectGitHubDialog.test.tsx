import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type {
  GitHubAuthStatus,
  GitHubRepoListItem,
  IpcResult,
  PmDesktopApi,
  ProjectStatus,
} from "../../../shared/ipc-contract.ts";
import { createTestQueryClient, withQueryClient } from "../test-helpers/query-client.tsx";
import { qk } from "../queries/keys.ts";
import type { QueryClient } from "@tanstack/react-query";

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

const { ConnectGitHubDialog, filterGitHubRepos, repoListFilterQuery } =
  await import("./ConnectGitHubDialog.tsx");

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function err(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

/** Drain the microtask queue enough to settle TanStack Query fetch + render. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const disconnectedStatus: GitHubAuthStatus = { connected: false, encryptionAvailable: true };
const oauthAvailable = true;

/** Pre-seed the shared query cache so the first render is synchronous. */
function seedQueries(
  client: QueryClient,
  overrides: {
    authStatus?: GitHubAuthStatus;
    oauthAvailable?: boolean;
    repos?: GitHubRepoListItem[];
  } = {},
): void {
  client.setQueryData(qk.githubAuthStatus, overrides.authStatus ?? disconnectedStatus);
  client.setQueryData(qk.githubOAuthAvailable, overrides.oauthAvailable ?? oauthAvailable);
  if (overrides.repos !== undefined) {
    client.setQueryData(qk.githubRepos, overrides.repos);
  }
}

const sampleStatus: ProjectStatus = {
  projectDir: "/data/projects/acme-web",
  configured: false,
  isGitRepository: true,
  configuredTrackers: [],
};

describe("filterGitHubRepos", () => {
  const repos = [
    { fullName: "acme/web", private: false, defaultBranch: "main" },
    { fullName: "acme/api", private: true, defaultBranch: "main" },
    { fullName: "other/docs", private: false, defaultBranch: "main" },
  ];

  test("empty or whitespace filter returns the full list", () => {
    expect(filterGitHubRepos(repos, "")).toEqual(repos);
    expect(filterGitHubRepos(repos, "  ")).toEqual(repos);
  });

  test("matches owner, repo substring, and full name case-insensitively", () => {
    expect(filterGitHubRepos(repos, "ACM").map((r) => r.fullName)).toEqual([
      "acme/web",
      "acme/api",
    ]);
    expect(filterGitHubRepos(repos, "docs").map((r) => r.fullName)).toEqual(["other/docs"]);
    expect(filterGitHubRepos(repos, "Acme/Web").map((r) => r.fullName)).toEqual(["acme/web"]);
  });

  test("normalizes github.com URLs before matching", () => {
    expect(repoListFilterQuery("https://github.com/acme/web")).toBe("acme/web");
    expect(filterGitHubRepos(repos, "https://github.com/acme/web").map((r) => r.fullName)).toEqual([
      "acme/web",
    ]);
  });

  test("returns empty array when nothing matches", () => {
    expect(filterGitHubRepos(repos, "nobody/nowhere")).toEqual([]);
  });
});

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
  let queryClient: QueryClient;

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

    queryClient = createTestQueryClient();

    container = document.createElement("div") as unknown as HTMLDivElement;
    document.body.appendChild(
      container as unknown as Parameters<typeof document.body.appendChild>[0],
    );
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    // Clear pending TanStack Query notifications before tearing down the DOM
    // so the notifyManager doesn't reference `window` after deletion.
    queryClient.clear();
    queryClient.unmount();
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
        withQueryClient(
          createElement(ConnectGitHubDialog, {
            open: true,
            onOpenChange,
            onConnected,
          }),
          queryClient,
        ),
      );
      await flushMicrotasks();
    });
    // Let seeded queries resolve + re-render with data.
    await act(async () => {
      await flushMicrotasks();
    });
  }

  async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
    // happy-dom does not deliver native `input` events to React's onChange (React 19
    // attaches listeners at the root container, and happy-dom's synthetic bubbling
    // does not reach them), so we invoke the fiber props handler directly — the same
    // path React would take after a real keystroke.
    //
    // The `__reactProps$` key prefix is an undocumented React implementation detail
    // that has changed between React majors (the `$` suffix arrived in React 17).
    // To avoid silent false-positive test passes on a future React upgrade, we
    // throw loudly when the props key or onChange handler is missing instead of
    // no-oping and letting filter assertions run against the unfiltered list.
    await act(async () => {
      const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"));
      if (!propsKey) {
        throw new Error(
          "typeInto: React fiber props key not found on input (React internal `__reactProps$*` changed?)",
        );
      }
      const props = (
        el as unknown as Record<string, { onChange?: (e: { target: { value: string } }) => void }>
      )[propsKey];
      if (!props?.onChange) {
        throw new Error("typeInto: React onChange handler not found on input");
      }
      props.onChange({ target: { value } });
      await Promise.resolve();
    });
  }

  test("shows Sign in with GitHub when auth is required and OAuth is available", async () => {
    seedQueries(queryClient);
    await renderOpen();
    expect(domWindow.document.querySelector('[data-testid="connect-github-oauth"]')).not.toBeNull();
    expect(
      domWindow.document.querySelector('[data-testid="connect-github-sign-in"]'),
    ).not.toBeNull();
    expect(domWindow.document.querySelector('[data-testid="connect-github-auth-ok"]')).toBeNull();
  });

  test("falls back to PAT field when OAuth is unavailable", async () => {
    isGitHubOAuthAvailable.mockImplementation(async () => ok(false));
    seedQueries(queryClient, { oauthAvailable: false });
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

    seedQueries(queryClient);
    await renderOpen();

    const signIn = domWindow.document.querySelector(
      '[data-testid="connect-github-sign-in"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      signIn!.click();
      await flushMicrotasks();
    });

    // Simulate the main process broadcasting the prompt.
    await act(async () => {
      promptCallback?.({ userCode: "AB-CDEF", verificationUri: "https://github.com/login/device" });
      await flushMicrotasks();
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
      await flushMicrotasks();
    });
  });

  test("Sign in with GitHub triggers startGitHubOAuth then loads repos", async () => {
    listGitHubRepos.mockImplementation(async () =>
      ok([{ fullName: "acme/web", private: false, defaultBranch: "main" }]),
    );

    seedQueries(queryClient);
    await renderOpen();

    const signIn = domWindow.document.querySelector(
      '[data-testid="connect-github-sign-in"]',
    ) as HTMLButtonElement | null;
    expect(signIn).not.toBeNull();
    // After sign-in the component invalidates githubAuthStatus; the refetch must
    // report a connected session for the "GitHub connected" banner to appear.
    getGitHubAuthStatus.mockImplementation(async () =>
      ok({
        connected: true,
        method: "oauth",
        login: "dana",
        encryptionAvailable: true,
        tokenEncrypted: true,
      }),
    );
    await act(async () => {
      signIn!.click();
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(startGitHubOAuth).toHaveBeenCalledTimes(1);
    expect(
      domWindow.document.querySelector('[data-testid="connect-github-auth-ok"]'),
    ).not.toBeNull();
  });

  test("repo pick from list and successful connect callback", async () => {
    const connectedStatus: GitHubAuthStatus = {
      connected: true,
      method: "oauth",
      login: "dana",
      encryptionAvailable: true,
      tokenEncrypted: true,
    };
    getGitHubAuthStatus.mockImplementation(async () => ok(connectedStatus));
    listGitHubRepos.mockImplementation(async () =>
      ok([
        {
          fullName: "acme/web",
          private: false,
          defaultBranch: "main",
        },
      ]),
    );

    seedQueries(queryClient, {
      authStatus: connectedStatus,
      repos: [{ fullName: "acme/web", private: false, defaultBranch: "main" }],
    });
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
      await flushMicrotasks();
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
      await flushMicrotasks();
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
    const connectedStatus: GitHubAuthStatus = {
      connected: true,
      method: "oauth",
      encryptionAvailable: true,
      tokenEncrypted: true,
    };
    getGitHubAuthStatus.mockImplementation(async () => ok(connectedStatus));
    listGitHubRepos.mockImplementation(async () =>
      ok([
        {
          fullName: "acme/web",
          private: false,
          defaultBranch: "main",
        },
      ]),
    );

    seedQueries(queryClient, {
      authStatus: connectedStatus,
      repos: [{ fullName: "acme/web", private: false, defaultBranch: "main" }],
    });
    await renderOpen();

    const pick = domWindow.document
      .querySelector('[data-testid="connect-github-repo-list"]')
      ?.querySelector("button") as HTMLButtonElement | null;
    expect(pick).not.toBeNull();
    await act(async () => {
      pick!.click();
      await flushMicrotasks();
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
      await flushMicrotasks();
    });

    expect(connectGitHubRepo.mock.calls[0]?.[0]).toEqual({
      repoInput: "acme/web",
      branch: undefined,
    });
  });

  test("typing in Repository filters the visible list case-insensitively", async () => {
    const connectedStatus: GitHubAuthStatus = {
      connected: true,
      method: "oauth",
      login: "dana",
      encryptionAvailable: true,
      tokenEncrypted: true,
    };
    getGitHubAuthStatus.mockImplementation(async () => ok(connectedStatus));
    listGitHubRepos.mockImplementation(async () =>
      ok([
        { fullName: "acme/web", private: false, defaultBranch: "main" },
        { fullName: "acme/api", private: true, defaultBranch: "main" },
        { fullName: "other/docs", private: false, defaultBranch: "main" },
      ]),
    );

    seedQueries(queryClient, {
      authStatus: connectedStatus,
      repos: [
        { fullName: "acme/web", private: false, defaultBranch: "main" },
        { fullName: "acme/api", private: true, defaultBranch: "main" },
        { fullName: "other/docs", private: false, defaultBranch: "main" },
      ],
    });
    await renderOpen();

    const list = () => domWindow.document.querySelector('[data-testid="connect-github-repo-list"]');
    expect(list()?.querySelectorAll("button")).toHaveLength(3);

    const repoInput = domWindow.document.querySelector(
      '[data-testid="connect-github-repo"]',
    ) as HTMLInputElement | null;
    expect(repoInput).not.toBeNull();

    await typeInto(repoInput!, "ACM");

    const filtered = [...(list()?.querySelectorAll("button") ?? [])].map(
      (b) => b.querySelector(".font-medium")?.textContent,
    );
    expect(filtered).toEqual(["acme/web", "acme/api"]);
    expect(list()?.textContent).toContain("private");
    expect(
      domWindow.document.querySelector('[data-testid="connect-github-repo-filter-empty"]'),
    ).toBeNull();

    await typeInto(repoInput!, "docs");
    expect(
      [...(list()?.querySelectorAll("button") ?? [])].map(
        (b) => b.querySelector(".font-medium")?.textContent,
      ),
    ).toEqual(["other/docs"]);

    await typeInto(repoInput!, "");
    expect(list()?.querySelectorAll("button")).toHaveLength(3);
  });

  test("filter empty state still allows freeform owner/repo connect", async () => {
    const connectedStatus: GitHubAuthStatus = {
      connected: true,
      method: "oauth",
      login: "dana",
      encryptionAvailable: true,
      tokenEncrypted: true,
    };
    getGitHubAuthStatus.mockImplementation(async () => ok(connectedStatus));
    listGitHubRepos.mockImplementation(async () =>
      ok([
        { fullName: "acme/web", private: false, defaultBranch: "main" },
        { fullName: "acme/api", private: true, defaultBranch: "main" },
      ]),
    );

    seedQueries(queryClient, {
      authStatus: connectedStatus,
      repos: [
        { fullName: "acme/web", private: false, defaultBranch: "main" },
        { fullName: "acme/api", private: true, defaultBranch: "main" },
      ],
    });
    await renderOpen();

    const repoInput = domWindow.document.querySelector(
      '[data-testid="connect-github-repo"]',
    ) as HTMLInputElement | null;
    expect(repoInput).not.toBeNull();

    await typeInto(repoInput!, "nobody/nowhere");

    expect(
      domWindow.document.querySelector('[data-testid="connect-github-repo-filter-empty"]'),
    ).not.toBeNull();
    expect(
      domWindow.document
        .querySelector('[data-testid="connect-github-repo-list"]')
        ?.querySelectorAll("button"),
    ).toHaveLength(0);

    const submit = domWindow.document.querySelector(
      '[data-testid="connect-github-submit"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      submit!.click();
      await flushMicrotasks();
    });

    expect(connectGitHubRepo).toHaveBeenCalledWith({
      repoInput: "nobody/nowhere",
      branch: undefined,
    });
    expect(onConnected).toHaveBeenCalledWith(sampleStatus);
  });

  test("github.com URL paste filters by normalized owner/repo", async () => {
    const connectedStatus: GitHubAuthStatus = {
      connected: true,
      method: "oauth",
      login: "dana",
      encryptionAvailable: true,
      tokenEncrypted: true,
    };
    getGitHubAuthStatus.mockImplementation(async () => ok(connectedStatus));
    listGitHubRepos.mockImplementation(async () =>
      ok([
        { fullName: "acme/web", private: false, defaultBranch: "main" },
        { fullName: "acme/api", private: true, defaultBranch: "main" },
      ]),
    );

    seedQueries(queryClient, {
      authStatus: connectedStatus,
      repos: [
        { fullName: "acme/web", private: false, defaultBranch: "main" },
        { fullName: "acme/api", private: true, defaultBranch: "main" },
      ],
    });
    await renderOpen();

    const repoInput = domWindow.document.querySelector(
      '[data-testid="connect-github-repo"]',
    ) as HTMLInputElement | null;

    await typeInto(repoInput!, "https://github.com/acme/web");

    const names = [
      ...(domWindow.document
        .querySelector('[data-testid="connect-github-repo-list"]')
        ?.querySelectorAll("button") ?? []),
    ].map((b) => b.querySelector(".font-medium")?.textContent);
    expect(names).toEqual(["acme/web"]);
  });

  test("clicking a filtered list item fills owner/repo and Connect works", async () => {
    const connectedStatus: GitHubAuthStatus = {
      connected: true,
      method: "oauth",
      login: "dana",
      encryptionAvailable: true,
      tokenEncrypted: true,
    };
    getGitHubAuthStatus.mockImplementation(async () => ok(connectedStatus));
    listGitHubRepos.mockImplementation(async () =>
      ok([
        { fullName: "acme/web", private: false, defaultBranch: "main" },
        { fullName: "acme/api", private: true, defaultBranch: "main" },
        { fullName: "other/docs", private: false, defaultBranch: "main" },
      ]),
    );

    seedQueries(queryClient, {
      authStatus: connectedStatus,
      repos: [
        { fullName: "acme/web", private: false, defaultBranch: "main" },
        { fullName: "acme/api", private: true, defaultBranch: "main" },
        { fullName: "other/docs", private: false, defaultBranch: "main" },
      ],
    });
    await renderOpen();

    const repoInput = domWindow.document.querySelector(
      '[data-testid="connect-github-repo"]',
    ) as HTMLInputElement | null;

    await typeInto(repoInput!, "api");

    const pick = domWindow.document
      .querySelector('[data-testid="connect-github-repo-list"]')
      ?.querySelector("button") as HTMLButtonElement | null;
    expect(pick?.textContent).toContain("acme/api");
    await act(async () => {
      pick!.click();
      await flushMicrotasks();
    });
    expect(repoInput?.value).toBe("acme/api");

    const submit = domWindow.document.querySelector(
      '[data-testid="connect-github-submit"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      submit!.click();
      await flushMicrotasks();
    });

    expect(connectGitHubRepo.mock.calls[0]?.[0]).toEqual({
      repoInput: "acme/api",
      branch: undefined,
    });
  });

  test("surfaces auth_required error and shows auth block", async () => {
    const connectedStatus: GitHubAuthStatus = {
      connected: true,
      method: "oauth",
      encryptionAvailable: true,
      tokenEncrypted: true,
    };
    getGitHubAuthStatus.mockImplementation(async () => ok(connectedStatus));
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

    seedQueries(queryClient, {
      authStatus: connectedStatus,
      repos: [{ fullName: "acme/private", private: true, defaultBranch: "main" }],
    });
    await renderOpen();

    const pick = domWindow.document
      .querySelector('[data-testid="connect-github-repo-list"]')
      ?.querySelector("button") as HTMLButtonElement | null;
    expect(pick).not.toBeNull();
    await act(async () => {
      pick!.click();
      await flushMicrotasks();
    });

    const submit = domWindow.document.querySelector(
      '[data-testid="connect-github-submit"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      submit!.click();
      await flushMicrotasks();
    });

    const error = domWindow.document.querySelector('[data-testid="connect-github-error"]');
    expect(error?.textContent).toContain("Connect a token");
    expect(domWindow.document.querySelector('[data-testid="connect-github-auth"]')).not.toBeNull();
  });

  test("surfaces forbidden listRepos error", async () => {
    const connectedStatus: GitHubAuthStatus = {
      connected: true,
      method: "oauth",
      encryptionAvailable: true,
      tokenEncrypted: true,
    };
    getGitHubAuthStatus.mockImplementation(async () => ok(connectedStatus));
    listGitHubRepos.mockImplementation(async () =>
      err("forbidden", "Token does not have access to list repositories."),
    );

    // Seed auth status only; let the repos query fetch so it surfaces the error.
    seedQueries(queryClient, { authStatus: connectedStatus });
    await renderOpen();
    await act(async () => {
      await flushMicrotasks();
    });

    const error = domWindow.document.querySelector('[data-testid="connect-github-error"]');
    expect(error?.textContent).toContain("does not have access");
    expect(domWindow.document.querySelector('[data-testid="connect-github-auth"]')).not.toBeNull();
  });
});
