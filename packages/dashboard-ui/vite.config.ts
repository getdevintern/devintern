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
    proxy: { "/api": "http://127.0.0.1:4400" },
  },
  build: { outDir: "dist" },
});
