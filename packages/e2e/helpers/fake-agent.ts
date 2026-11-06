#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// A one-shot fixture run can pin its mode explicitly. A long-lived worker
// cannot: the same daemon runs implementation, review, CI-repair and conflict
// jobs, so those tests identify the prompt by a seeded marker instead.
const agentInput = process.argv.join(" ");
// Batch tests seed a unique alphanumeric token into each task body as
// `E2EPROMPTMARKER<TOKEN>`. Recording every marker this invocation saw proves
// each task's own prompt reached the agent, in order, even when every task
// produces the same file edit. Tokens must stay alphanumeric: tracker
// descriptions pass through HTML-to-Markdown conversion, which escapes `_` and
// other Markdown-special characters before the prompt reaches this process.
const promptMarkers = [...agentInput.matchAll(/E2EPROMPTMARKER[A-Z0-9]+/g)].map(
  (match) => match[0],
);
// The local auto-review loop sends the bundled review and fix prompts from the
// same one-shot CLI run that implemented the task. Detect those turns before
// the explicit E2E_AGENT_MODE so a single run can exercise
// implement → review → fix → review without the fixture pinning one mode.
const promptMode = agentInput.includes("You are reviewing a pull request")
  ? "auto-review-feedback"
  : agentInput.includes("## Feedback to Address")
    ? "auto-review-fix"
    : undefined;
const mode =
  promptMode ??
  process.env.E2E_AGENT_MODE ??
  (agentInput.includes("# Resolve Merge Conflicts")
    ? "conflict"
    : agentInput.includes("E2E_CI_FIX_MARKER")
      ? "ci"
      : agentInput.includes("E2E_REVIEW_GREETING")
        ? "review"
        : agentInput.includes("E2E_NO_CHANGE")
          ? "no-change"
          : "implement");
if (process.env.E2E_AGENT_INVOCATIONS) {
  // Automation subprocesses carry the owning schedule id, so a worker test can
  // attribute each agent invocation to the automation that spawned it instead
  // of relying on global mode counts.
  const automation = process.env.DEVINTERN_AUTOMATION_ID;
  appendFileSync(
    process.env.E2E_AGENT_INVOCATIONS,
    JSON.stringify({
      mode,
      ...(promptMarkers.length > 0 ? { promptMarkers } : {}),
      ...(automation ? { automation } : {}),
    }) + "\n",
  );
}
// Opt-in delay for bounded-timeout coverage. Defaults to 0, so every existing
// scenario stays as fast and deterministic as before.
const delayMs = Number(process.env.E2E_AGENT_DELAY_MS ?? "0");
if (Number.isFinite(delayMs) && delayMs > 0) {
  await Bun.sleep(delayMs);
}
// Narrow, explicit per-task failure for batch-isolation coverage. Unlike the
// process-wide E2E_AGENT_MODE, this only affects a prompt carrying the marker,
// so one task in a batch can fail while the others still implement.
//
// The marker must be alphanumeric. Tracker descriptions are Markdown-escaped
// before they reach the agent (`E2E_FAIL_ABC` arrives as `E2E\_FAIL\_ABC`), so a
// marker containing Markdown-special characters would silently never match.
// Fail loudly instead of letting a future scenario pass without failing.
const failPromptMarker = process.env.E2E_FAIL_PROMPT_MARKER;
if (failPromptMarker) {
  if (!/^[A-Za-z0-9]+$/.test(failPromptMarker)) {
    throw new Error(
      "E2E_FAIL_PROMPT_MARKER must be alphanumeric: Markdown escaping prevents a marker with special characters from matching",
    );
  }
  if (agentInput.includes(failPromptMarker)) {
    console.error("E2E deliberate prompt-marker failure");
    process.exit(18);
  }
}
// A settled-but-failed attempt with an implementation report, for resume
// coverage: exit 0 with failure language so the pipeline records an escalated
// run (branch + report) without editing the fixture. `incomplete` leaves one
// landed (empty) commit because session pickup only reuses a branch that has
// commits ahead of its base, even when the run recorded a report.
// `incomplete-empty` skips the commit to cover the documented fallback to a
// fresh attempt branch when the prior branch has nothing to resume.
if (mode === "incomplete" || mode === "incomplete-empty") {
  if (mode === "incomplete") {
    const commit = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=DevIntern E2E",
        "-c",
        "user.email=e2e@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "wip: interrupted attempt",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (commit.exitCode !== 0) {
      throw new Error(commit.stdout.toString() + commit.stderr.toString());
    }
  }
  console.log(
    "Implementation was unsuccessful. I could not complete the requested change because the deterministic E2E fixture intentionally stopped before editing any tracked file. The branch and run record must remain available for a resume attempt.",
  );
  process.exit(0);
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
// Auto-review reviewer turn: print only the JSON verdict the loop parses. The
// first iteration reports one blocking medium finding; a later iteration
// approves so the loop converges. E2E_AUTO_REVIEW_STUCK keeps every iteration
// unapproved to prove the iteration cap.
if (mode === "auto-review-feedback") {
  const iteration = Number(agentInput.match(/\*\*Review Iteration\*\*:\s*(\d+)/)?.[1] ?? "1");
  const stuck = process.env.E2E_AUTO_REVIEW_STUCK === "1";
  if (!stuck && iteration > 1) {
    console.log(
      JSON.stringify({
        summary: "The review finding was addressed and no blocking issues remain.",
        approved: true,
        items: [],
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        summary: "The greeting change works, but the exported value is not asserted.",
        approved: false,
        items: [
          {
            priority: "medium",
            confidence: "high",
            category: "code-quality",
            file: "src/greeting.ts",
            line: "1",
            issue:
              "The fixture test only checks a Hello prefix, so it cannot catch a wrong greeting value.",
            evidence:
              "tests/greeting.test.ts:5 asserts only a Hello prefix, not the exact exported value",
            suggestion: "Assert the exact exported greeting value in tests/greeting.test.ts.",
          },
        ],
      }),
    );
  }
  process.exit(0);
}
// Auto-review fixer turn: apply the suggested edit and leave the commit to the
// production loop. Accept an already-fixed file so a later fix turn is a no-op.
if (mode === "auto-review-fix") {
  const fixedPath = "src/greeting.ts";
  const fixed = 'export const greeting = "Hello, reviewer!";\n';
  const current = readFileSync(fixedPath, "utf8");
  if (current !== fixed) {
    if (current !== 'export const greeting = "Hello, world!";\n') {
      throw new Error("Unexpected fixture contents; refusing to edit this workspace");
    }
    writeFileSync(fixedPath, fixed);
  }
  console.log("Applied the review suggestion: src/greeting.ts now exports Hello, reviewer!");
  process.exit(0);
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
