import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import pkg from "./package.json";

await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  minify: true,
  // Bun applies the adjacent map to runtime stack traces, so errors resolve to
  // `src/...` paths. Automatic defect reports rely on that to tell DevIntern's
  // own frames from vendored dependencies (`node_modules/...`) in the bundle.
  sourcemap: "external",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    // True only in publish jobs: release bundles ignore DEVINTERN_SKIP_LICENSE_CHECK
    // and DEVINTERN_API_BASE. Local and e2e builds leave it unset.
    __DEVINTERN_RELEASE_BUILD__: JSON.stringify(process.env.DEVINTERN_RELEASE_BUILD === "1"),
    // Analytics is permanently disabled in builds without a key (local dev).
    __POSTHOG_API_KEY__: JSON.stringify(process.env.POSTHOG_API_KEY?.trim() ?? ""),
    __POSTHOG_HOST__: JSON.stringify(
      process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
    ),
  },
});

// Replace shebang to use bun instead of node
const distPath = "dist/index.js";
let content = readFileSync(distPath, "utf8");
content = content.replace("#!/usr/bin/env node", "#!/usr/bin/env bun");
writeFileSync(distPath, content);

// The published package already ships `src/`, so the map only needs positions.
// Drop the embedded sources to keep the artifact small; Bun still decodes the
// map as long as `sourcesContent` has one entry per source.
const mapPath = "dist/index.js.map";
const sourceMap = JSON.parse(readFileSync(mapPath, "utf8")) as { sources: string[] };
writeFileSync(
  mapPath,
  JSON.stringify({ ...sourceMap, sourcesContent: sourceMap.sources.map(() => null) }),
);

// Build the observability dashboard UI (sibling workspace package) and ship
// its static assets inside this package so `devintern dashboard` works from
// the published npm artifact without the monorepo.
const uiPackageDir = join(import.meta.dir, "..", "dashboard-ui");
const uiDist = join(uiPackageDir, "dist");

// Turbo builds workspace dependencies first. Keep the package-level command
// self-contained for contributors who run `bun run build` from this directory.
if (!process.env.TURBO_HASH) {
  const uiBuild = Bun.spawnSync(["bun", "run", "build"], { cwd: uiPackageDir });
  if (uiBuild.exitCode !== 0) {
    console.error(uiBuild.stderr.toString());
    process.exit(1);
  }
}

if (!existsSync(join(uiDist, "index.html"))) {
  console.error("dashboard-ui build failed; refusing to package without the dashboard UI.");
  process.exit(1);
}
rmSync("dist/dashboard-ui", { recursive: true, force: true });
cpSync(uiDist, "dist/dashboard-ui", { recursive: true });

// Ship the versioned prompt catalog next to the bundle so `loadPrompt` can
// resolve it relative to dist/index.js in published artifacts.
rmSync("dist/prompts", { recursive: true, force: true });
cpSync("prompts", "dist/prompts", { recursive: true });

// Ship the bundled automation catalog next to the bundle so
// `devintern automations add` and the `doctor` catalog check work from the
// published npm artifact.
rmSync("dist/catalog", { recursive: true, force: true });
cpSync("catalog", "dist/catalog", { recursive: true });

console.log(`Built devintern v${pkg.version} (with dashboard UI)`);
