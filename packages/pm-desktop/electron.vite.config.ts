import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin, loadEnv } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const packageRoot = import.meta.dirname;

export default defineConfig(({ mode }) => {
  // Load packages/pm-desktop/.env* (all keys — not only MAIN_VITE_*).
  // Shell / CI env wins over file values when both are set.
  const fileEnv = loadEnv(mode, packageRoot, "");
  const posthogApiKey = process.env.POSTHOG_API_KEY ?? fileEnv.POSTHOG_API_KEY ?? "";
  const posthogHost =
    process.env.POSTHOG_HOST ?? fileEnv.POSTHOG_HOST ?? "https://us.i.posthog.com";

  return {
    main: {
      // Bake PostHog credentials into release builds (set via .env, shell, or CI).
      // Absent key → analytics no-ops at runtime. Prefer env over hardcoding.
      define: {
        "process.env.POSTHOG_API_KEY": JSON.stringify(posthogApiKey),
        "process.env.POSTHOG_HOST": JSON.stringify(posthogHost),
      },
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
          "@": resolve(packageRoot, "src/renderer/src"),
        },
      },
      build: {
        rollupOptions: {
          output: {
            // Keep @mdxeditor/editor (Lexical, CodeMirror, Radix) in its own
            // chunk — lazy-loaded from OutputPanel so first paint stays small.
            manualChunks(id) {
              if (id.includes("node_modules/@mdxeditor/")) return "mdxeditor";
              if (id.includes("node_modules/lexical") || id.includes("node_modules/@lexical/")) {
                return "mdxeditor";
              }
              if (id.includes("node_modules/@codemirror/")) return "mdxeditor";
            },
          },
        },
      },
    },
  };
});
