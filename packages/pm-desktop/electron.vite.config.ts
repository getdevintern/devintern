import { resolve } from "node:path";
import { defineConfig, loadEnv } from "electron-vite";
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
  const githubOauthClientId =
    process.env.GITHUB_OAUTH_CLIENT_ID ?? fileEnv.GITHUB_OAUTH_CLIENT_ID ?? "";

  return {
    main: {
      // Bake PostHog credentials and the GitHub OAuth App Client ID into release
      // builds (set via .env, shell, or CI). Absent PostHog key → analytics no-ops.
      // The GitHub Client ID is public (device flow needs no secret); absent ID →
      // the "Sign in with GitHub" button is hidden and PAT remains available.
      define: {
        "process.env.POSTHOG_API_KEY": JSON.stringify(posthogApiKey),
        "process.env.POSTHOG_HOST": JSON.stringify(posthogHost),
        "process.env.GITHUB_OAUTH_CLIENT_ID": JSON.stringify(githubOauthClientId),
      },
      // Bundle workspace TS packages (they ship raw .ts sources); keep real
      // node_modules external. electron-vite 5 externalizes deps by default.
      build: {
        externalizeDeps: {
          exclude: [
            "@getdevintern/pm",
            "@devintern/agent-harness",
            "@devintern/task-trackers",
            "@devintern/text-formatter",
            "@devintern/utils",
          ],
        },
      },
    },
    // Explicit empty config keeps the default `src/preload` entry (v5 warns if omitted).
    preload: {},
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
