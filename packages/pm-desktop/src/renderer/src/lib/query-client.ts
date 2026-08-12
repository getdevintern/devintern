import { QueryClient } from "@tanstack/react-query";

/**
 * Shared TanStack Query client for the pm-desktop renderer.
 *
 * Defaults are tuned for an Electron app whose "server" is the local main
 * process: there is no network to retry over, no remote staleness to
 * background-refetch, and IPC failures are not transient blips. We invalidate
 * explicitly on project context changes instead.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: Infinity,
    },
  },
});
