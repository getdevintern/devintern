import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { installGlobalErrorReporting } from "./lib/error-reporting.ts";
import { queryClient } from "./lib/query-client.ts";
// oxlint-disable-next-line import/no-unassigned-import -- global stylesheet entry
import "./styles.css";

// Renderer errors (window error/unhandledrejection) are forwarded to main and
// reported only if telemetry is enabled there; React crashes additionally land
// in the boundary below so the UI survives a render failure.
installGlobalErrorReporting();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
