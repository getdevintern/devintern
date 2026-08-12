import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { queryClient } from "./lib/query-client.ts";
// oxlint-disable-next-line import/no-unassigned-import -- global stylesheet entry
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
