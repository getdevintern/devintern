import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    // Bundle workspace TS packages (they ship raw .ts sources); keep real
    // node_modules external.
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@getdevintern/pm",
          "@devintern/agent-harness",
          "@devintern/task-trackers",
          "@devintern/text-formatter",
          "@devintern/utils",
        ],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "src/renderer/src"),
      },
    },
  },
});
