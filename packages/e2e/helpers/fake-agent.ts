#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";

// Only this deterministic edit is simulated; git and GitHub run normally.
const path = "src/greeting.ts";
if (readFileSync(path, "utf8") !== 'export const greeting = "Hello";\n') {
  throw new Error("Unexpected fixture contents; refusing to edit this workspace");
}
writeFileSync(path, 'export const greeting = "Hello, world!";\n');
const check = Bun.spawnSync([process.execPath, "test"], { stdout: "pipe", stderr: "pipe" });
if (check.exitCode !== 0) {
  throw new Error(check.stdout.toString() + check.stderr.toString());
}
console.log(`<!-- devintern:summary:start -->
## Why
The fixture needs a more descriptive greeting.
## What changed
Updated src/greeting.ts to export Hello, world!.
## Scope
The greeting export is the only changed file.
## Tradeoffs
A fixed string keeps this fixture deterministic.
## Blast Radius
The greeting test consumes the export and still passes.
## Verification
Ran bun test successfully in the fixture project.
<!-- devintern:summary:end -->`);
