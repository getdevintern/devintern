/**
 * Detection of installed sandbox providers.
 *
 * Detection shells out (`which`, `--version` probes), so results are cached
 * per process: one-shot CLI runs re-detect naturally on the next invocation,
 * while long-lived hosts (webhook server, worker daemon) pick up newly
 * installed providers after a restart.
 */

import { listSandboxProviders } from "./registry.js";
import type { SandboxDetection, SandboxProvider } from "./types.js";

export interface DetectedSandboxProvider {
  provider: SandboxProvider;
  detection: SandboxDetection;
}

let cache: Promise<DetectedSandboxProvider[]> | null = null;

/**
 * Run `detect()` on every registered provider in parallel.
 *
 * @param options - Set `fresh: true` to bypass the per-process cache.
 * @returns One entry per registered provider, in registration order.
 */
export function detectSandboxProviders(options?: {
  fresh?: boolean;
}): Promise<DetectedSandboxProvider[]> {
  if (options?.fresh || !cache) {
    cache = Promise.all(
      listSandboxProviders().map(async (provider) => {
        try {
          return { provider, detection: await provider.detect() };
        } catch (error) {
          return {
            provider,
            detection: {
              available: false,
              reason: `detection failed: ${(error as Error).message}`,
            },
          };
        }
      }),
    );
  }
  return cache;
}
