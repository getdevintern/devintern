import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import type { ReactNode } from "react";

/**
 * Create a fresh QueryClient for a single test. Defaults are tuned for tests:
 * no retries, no garbage collection lag, no stale time, and no background
 * refetch so mocks are called exactly once per mount.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

/**
 * Wrap a React node in a QueryClientProvider so components using TanStack
 * Query hooks (useUpdateStatus, useLabels, etc.) render in tests.
 */
export function withQueryClient(node: ReactNode, client?: QueryClient): ReactNode {
  const qc = client ?? createTestQueryClient();
  return createElement(QueryClientProvider, { client: qc }, node);
}
