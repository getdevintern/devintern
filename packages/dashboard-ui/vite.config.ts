import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
  server: {
    // Frontend iteration against a running `devintern dashboard` server.
    // DASHBOARD_API_PORT points the proxy at a source-run server (e.g. 4401).
    proxy: { "/api": `http://127.0.0.1:${process.env.DASHBOARD_API_PORT || "4400"}` },
  },
  build: { outDir: "dist" },
});
