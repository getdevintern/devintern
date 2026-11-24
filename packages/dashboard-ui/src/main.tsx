import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import { installDemoFetch, isDemoMode } from "@/lib/demo";
// oxlint-disable-next-line import/no-unassigned-import -- global stylesheet entry
import "./styles.css";

// The demo build answers `/api/*` from recorded responses (see lib/demo.ts).
if (isDemoMode()) installDemoFetch();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
