/** Delimit the final reviewer briefing independently of streamed progress. */
import {
  IMPLEMENTATION_SUMMARY_END as SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START as SUMMARY_START,
} from "@devintern/agent-harness";

/** Request a complete final summary in implementation and repair sessions. */
export function withImplementationSummary(prompt: string): string {
  return `${prompt}

## Final implementation summary
When implementation is complete, finish your response with a concise reviewer briefing
between these exact marker lines. Use all six Markdown headings below. Keep progress
messages outside the markers. Report facts from the completed work, not your plan.
If you cannot complete the task or need user input, report that honestly instead.

${SUMMARY_START}
## Why
Explain the problem and the resulting behavior.
## What changed
Describe the final implementation and key files.
## Scope
State what is included and explicitly excluded.
## Tradeoffs
Explain the choices made and their costs. If none are meaningful, say so and why.
## Blast Radius
Name affected callers, consumers, and possible regressions based on code you inspected.
## Verification
List commands actually run and their results, including failures and unverified behavior.
${SUMMARY_END}

Do not leave sections empty or use N/A for information you did not investigate.
Do not repeat the instructional placeholder text above in your summary.`;
}

/**
 * Select the last complete final briefing, ignoring marker examples in code fences.
 * Preserve legacy output when an agent omits or truncates the summary protocol.
 */
export function extractImplementationSummary(output: string): string {
  let fence: { marker: string; length: number } | undefined;
  let buffer: string[] | undefined;
  let summary: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        delimiter &&
        delimiter[1][0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        /^\s{0,3}([`~]{3,})\s*$/.test(line)
      ) {
        fence = undefined;
      }
      buffer?.push(line);
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      buffer?.push(line);
    } else if (trimmed === SUMMARY_START) {
      buffer = [];
    } else if (trimmed === SUMMARY_END && buffer) {
      const candidate = buffer.join("\n").trim();
      if (candidate) summary = candidate;
      buffer = undefined;
    } else {
      buffer?.push(line);
    }
  }
  return summary ?? output;
}
