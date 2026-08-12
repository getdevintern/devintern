import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
// oxlint-disable-next-line import/no-unassigned-import -- global stylesheet entry
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
