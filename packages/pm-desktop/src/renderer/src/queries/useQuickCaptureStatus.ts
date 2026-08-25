import { useQuery } from "@tanstack/react-query";

import type { QuickCaptureStatus } from "../../../shared/ipc-contract.ts";
import { unwrap } from "../lib/ipc-query.ts";
import { qk } from "./keys.ts";

/**
 * Quick Capture registration snapshot (enabled, effective accelerator,
 * registered flag, conflict error). Gated on dialog open — the Settings
 * dialog is the only reader.
 */
export function useQuickCaptureStatus(enabled: boolean) {
  return useQuery<QuickCaptureStatus>({
    queryKey: qk.quickCapture,
    queryFn: async () => unwrap(await window.pm.getQuickCaptureStatus()),
    enabled,
    staleTime: Infinity,
  });
}
