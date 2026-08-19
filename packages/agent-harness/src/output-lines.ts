/**
 * Line-level helpers for scanning agent CLI transcripts.
 *
 * Codex writes its full tool transcript to stderr, so callers must not treat
 * either stream as trusted diagnostics. Split into lines, strip ANSI, and skip
 * source / diff / search output before matching error phrases.
 */

export interface OutputLine {
  raw: string;
  normalized: string;
}

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");

/**
 * Strip terminal styling before matching, while retaining the original line
 * for diagnostics.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

/**
 * Split one captured stream into matchable lines.
 */
export function outputLines(text: string): OutputLine[] {
  return text.split(/\r?\n/).map((raw) => ({
    raw,
    normalized: stripAnsi(raw),
  }));
}

/**
 * Avoid treating source code, comments, quoted Markdown, search results, and
 * diff hunks as provider errors. Agent transcripts can include arbitrary file
 * content from tools such as `sed`, `rg`, and `git diff`.
 */
export function isSourceOrDiffLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^(?:diff --git|index\b|---\s|\+\+\+\s|@@\s)/i.test(trimmed) ||
    /^[+-](?![+-])/.test(trimmed) ||
    /^(?:\/\/|\/\*|\*|#|>|```|~~~)/.test(trimmed) ||
    // `rg -n`, grep, and compiler-style locations: path:line[:column]:content.
    /^(?:(?:\.?\.?\/|\/)?(?:[^:\s]+\/)+[^:\s]+|[^:\s]+\.[a-z\d]+):\d+(?::\d+)?:/i.test(trimmed) ||
    /^(?:const|let|var|function|class|import|export|return)\b/.test(trimmed) ||
    /^(?:super|throw\s+new\s+Error|[\w$.]+\.(?:error|warn|log))\s*\(/.test(trimmed) ||
    /^(?:["'`]).*(?:["'`])[,;)]?$/.test(trimmed) ||
    /\b(?:includes|startsWith|endsWith|\.match|\.test)\s*\(/.test(trimmed) ||
    /=>/.test(trimmed)
  );
}
