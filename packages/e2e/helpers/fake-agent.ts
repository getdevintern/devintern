#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// A one-shot fixture run can pin its mode explicitly. A long-lived worker
// cannot: the same daemon runs implementation, review, CI-repair and conflict
// jobs, so those tests identify the prompt by a seeded marker instead.
const agentInput = process.argv.join(" ");
const mode =
  process.env.E2E_AGENT_MODE ??
  (agentInput.includes("# Resolve Merge Conflicts")
    ? "conflict"
    : agentInput.includes("E2E_CI_FIX_MARKER")
      ? "ci"
      : agentInput.includes("E2E_REVIEW_GREETING")
        ? "review"
        : "implement");
if (process.env.E2E_AGENT_INVOCATIONS) {
  appendFileSync(process.env.E2E_AGENT_INVOCATIONS, JSON.stringify({ mode }) + "\n");
}
// Tracker scenarios seed unique markers into the ticket description and a
// comment; both must reach the agent's actual input before it edits anything.
const missingMarkers: string[] = [];
if (
  process.env.E2E_EXPECT_DESCRIPTION_MARKER &&
  !agentInput.includes(process.env.E2E_EXPECT_DESCRIPTION_MARKER)
) {
  missingMarkers.push("description");
}
if (
  process.env.E2E_EXPECT_COMMENT_MARKER &&
  !agentInput.includes(process.env.E2E_EXPECT_COMMENT_MARKER)
) {
  missingMarkers.push("comment");
}
if (missingMarkers.length > 0) {
  throw new Error(`Seeded ${missingMarkers.join(" and ")} marker(s) did not reach the agent input`);
}
const path = "src/greeting.ts";
if (mode === "no-change") {
  console.log(
    "The fixture was inspected and the deterministic execution has finished. This invocation intentionally left src/greeting.ts and all other tracked files unchanged. No additional actions were performed.",
  );
  process.exit(0);
}
const expected =
  mode === "implement"
    ? 'export const greeting = "Hello";\n'
    : 'export const greeting = "Hello, world!";\n';
if (mode !== "conflict" && readFileSync(path, "utf8") !== expected)
  throw new Error("Unexpected fixture contents; refusing to edit this workspace");
if (mode === "review" && !agentInput.includes("E2E_REVIEW_GREETING")) {
  throw new Error("Review feedback marker was not delivered to the agent");
}
if (mode === "ci" && process.env.E2E_FAIL_CI === "1") {
  console.error("E2E deliberate CI repair failure");
  process.exit(19);
}
const replacement =
  mode === "review"
    ? 'export const greeting = "Hello, reviewer!";\n'
    : mode === "ci"
      ? 'export const greeting = "Hello, CI!";\n'
      : mode === "conflict"
        ? 'export const greeting = "Hello, merged!";\n'
        : 'export const greeting = "Hello, world!";\n';
writeFileSync(path, replacement);
if (mode === "conflict") {
  // The merge resolver trusts the index, not the agent's output: stage the
  // resolved file so `git diff --diff-filter=U` no longer reports it.
  const add = Bun.spawnSync(["git", "add", "-A"], { stdout: "pipe", stderr: "pipe" });
  if (add.exitCode !== 0) {
    throw new Error(add.stdout.toString() + add.stderr.toString());
  }
}
if (mode === "fail") {
  console.error("E2E deliberate implementation failure after editing the fixture");
  process.exit(17);
}
const check = Bun.spawnSync([process.execPath, "test"], { stdout: "pipe", stderr: "pipe" });
if (check.exitCode !== 0) {
  throw new Error(check.stdout.toString() + check.stderr.toString());
}
const greeting = replacement.match(/"([^"]+)"/)?.[1] ?? "Hello, world!";
console.log(`<!-- devintern:summary:start -->
## Why
The fixture needs a more descriptive greeting.
## What changed
Updated src/greeting.ts to export ${greeting}.
## Scope
The greeting export is the only changed file.
## Tradeoffs
A fixed string keeps this fixture deterministic.
## Blast Radius
The greeting test consumes the export and still passes.
## Verification
Ran bun test successfully in the fixture project.
<!-- devintern:summary:end -->`);
