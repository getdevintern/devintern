/**
 * Tiny fixture generator. Run it to create the artifact the example checks:
 *
 *   bun run examples/pipeline-plugins/verify-artifacts/fixtures/generate.ts valid   ./dist
 *   bun run examples/pipeline-plugins/verify-artifacts/fixtures/generate.ts invalid ./dist
 *
 * `valid` writes every required field; `invalid` omits `checks` so the plugin's
 * halt path can be reproduced.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const mode = process.argv[2] === "invalid" ? "invalid" : "valid";
const outputDir = resolve(process.argv[3] ?? ".");

const report =
  mode === "valid"
    ? { version: "1.0.0", checks: ["lint", "test"], generatedAt: new Date().toISOString() }
    : { version: "1.0.0", generatedAt: new Date().toISOString() };

mkdirSync(outputDir, { recursive: true });
const target = join(outputDir, "report.json");
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Wrote ${mode} artifact to ${target}`);
