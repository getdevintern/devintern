#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.E2E_AGENT_MODE ?? "implement";
if (process.env.E2E_AGENT_INVOCATIONS) {
  appendFileSync(process.env.E2E_AGENT_INVOCATIONS, JSON.stringify({ mode }) + "\n");
}
const path = "src/greeting.ts";
if (mode === "no-change") {
  console.log(
    "The fixture was inspected and the deterministic execution has finished. This invocation intentionally left src/greeting.ts and all other tracked files unchanged. No additional actions were performed.",
  );
  process.exit(0);
}
const expected =
  mode === "review"
    ? 'export const greeting = "Hello, world!";\n'
    : 'export const greeting = "Hello";\n';
if (readFileSync(path, "utf8") !== expected)
  throw new Error("Unexpected fixture contents; refusing to edit this workspace");
if (mode === "review" && !process.argv.join(" ").includes("E2E_REVIEW_GREETING")) {
  throw new Error("Review feedback marker was not delivered to the agent");
}
writeFileSync(
  path,
  mode === "review"
    ? 'export const greeting = "Hello, reviewer!";\n'
    : 'export const greeting = "Hello, world!";\n',
);
if (mode === "fail") {
  console.error("E2E deliberate implementation failure after editing the fixture");
  process.exit(17);
}
const check = Bun.spawnSync([process.execPath, "test"], { stdout: "pipe", stderr: "pipe" });
if (check.exitCode !== 0) {
  throw new Error(check.stdout.toString() + check.stderr.toString());
}
console.log(`<!-- devintern:summary:start -->
## Why
The fixture needs a more descriptive greeting.
## What changed
Updated src/greeting.ts to export ${mode === "review" ? "Hello, reviewer!" : "Hello, world!"}.
## Scope
The greeting export is the only changed file.
## Tradeoffs
A fixed string keeps this fixture deterministic.
## Blast Radius
The greeting test consumes the export and still passes.
## Verification
Ran bun test successfully in the fixture project.
<!-- devintern:summary:end -->`);
