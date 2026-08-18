import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { PmDesktopApi } from "../../../shared/ipc-contract.ts";
import type { ToolValidation } from "../../../shared/tool-validation.ts";
import { useToolValidation } from "./useToolValidation.ts";

const validation: ToolValidation = {
  ok: true,
  tools: [],
  warnings: [],
  installedHarnesses: [],
};

function Probe(): null {
  useToolValidation();
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(0);
  }
}

describe("useToolValidation", () => {
  let domWindow: Window;
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let validateRequiredTools: ReturnType<typeof mock>;

  beforeEach(() => {
    domWindow = new Window();
    globalThis.document = domWindow.document as unknown as Document;
    globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

    validateRequiredTools = mock(async () => ({ ok: true as const, value: validation }));
    (domWindow as unknown as { pm: PmDesktopApi }).pm = {
      validateRequiredTools,
    } as unknown as PmDesktopApi;

    container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.appendChild(
      container as unknown as Parameters<typeof domWindow.document.body.appendChild>[0],
    );
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
          refetchOnWindowFocus: false,
        },
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      client.clear();
      await flushMicrotasks();
    });
    container.remove();
    // @ts-expect-error test teardown
    delete globalThis.document;
    // @ts-expect-error test teardown
    delete globalThis.window;
    domWindow.close();
  });

  test("probes IPC again when the app regains focus", async () => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
      await flushMicrotasks();
    });
    expect(validateRequiredTools).toHaveBeenCalledTimes(1);

    await act(async () => {
      domWindow.dispatchEvent(new domWindow.Event("visibilitychange"));
      await flushMicrotasks();
    });

    expect(validateRequiredTools).toHaveBeenCalledTimes(2);
  });
});
