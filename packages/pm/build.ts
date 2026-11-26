import pkg from "./package.json";

await Bun.build({
  entrypoints: ["index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  minify: true,
  external: [
    "ink",
    "react",
    "ink-scroll-view",
    "chat",
    "@chat-adapter/slack",
    "@chat-adapter/telegram",
    "@chat-adapter/state-memory",
  ],
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    // True only in publish jobs: release bundles ignore DEVINTERN_SKIP_LICENSE_CHECK
    // and DEVINTERN_API_BASE. Local and e2e builds leave it unset.
    __DEVINTERN_RELEASE_BUILD__: JSON.stringify(process.env.DEVINTERN_RELEASE_BUILD === "1"),
  },
});

console.log(`Built @getdevintern/pm v${pkg.version}`);
