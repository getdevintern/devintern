import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import pkg from "./package.json";

await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  minify: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
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

console.log(`Built devintern v${pkg.version} (with dashboard UI)`);
