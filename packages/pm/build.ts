import pkg from "./package.json";

await Bun.build({
  entrypoints: ["index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  minify: true,
  external: ["ink", "react", "ink-scroll-view"],
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});

console.log(`Built @getdevintern/pm v${pkg.version}`);
