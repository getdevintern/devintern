import type { PmDesktopApi } from "../../shared/ipc-contract.ts";

declare global {
  interface Window {
    pm: PmDesktopApi;
  }
}

export {};
