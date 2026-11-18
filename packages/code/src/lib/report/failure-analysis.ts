/**
 * Failure analysis for automatic defect reports.
 *
 * Decides, from the thrown error alone, whether a failed task run is a
 * DevIntern defect, a task/environment problem, or inconclusive. The analysis
 * is deterministic and local: it never reads task content, logs, or agent
 * transcripts, and it never spawns an agent. That keeps it cheap, testable,
 * and impossible to recurse into another task run.
 *
 * Only `defect` verdicts are reported. The verdict is deliberately strict: a
 * JavaScript programming error (TypeError, ReferenceError, RangeError, …)
 * whose innermost application frame is DevIntern's own code. Everything else
 * that is not recognisably task-specific is `inconclusive` and never sent.
 *
 * Attribution is by source path. The published bundle (`dist/index.js`) ships
 * with `dist/index.js.map`, which Bun applies to stack traces, so frames
 * resolve to `<pkg>/src/...`, sibling shared packages, or `node_modules/...`.
 * A frame that still points at the bundle itself (map missing or unreadable)
 * cannot be attributed, and makes the verdict `inconclusive`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { buildFingerprint } from "./fingerprint";
import { redactReportText } from "./redact";

export type FailureVerdict = "defect" | "task" | "inconclusive";

/** One DevIntern-owned stack frame, with a package-relative location. */
export interface DevInternFrame {
  fn?: string;
  /** Package-relative file path, e.g. `src/lib/task/pipeline.ts`. */
  file: string;
  line?: number;
}

export interface FailureAnalysis {
  verdict: FailureVerdict;
  /** One-line reason for the verdict, safe to show and to send. */
  rationale: string;
  /** Error class name (`TypeError`), present for defects. */
  errorName?: string;
  /** Sanitized error message, present for defects. */
  message?: string;
  /** DevIntern-owned frames, innermost first (at most {@link MAX_FRAMES}). */
  frames?: DevInternFrame[];
  /** Stable signature for duplicate detection, present for defects. */
  signature?: string;
}

export interface AnalyzeFailureOptions {
  /** DevIntern package root; defaults to the installed `@getdevintern/code`. */
  packageRoot?: string | null;
  /** Checkout and home paths to redact from the message. */
  cwd?: string;
  homeDir?: string;
  /** Pipeline step that was active when the run failed (e.g. `implementation`). */
  failedStep?: string;
  /**
   * Whether function names in stack frames are minified (the published
   * bundle). They are dropped then: unreadable, and they change every release.
   * Defaults to whether this module is running from the bundle.
   */
  minifiedNames?: boolean;
}

const MAX_FRAMES = 8;
const MAX_MESSAGE_CHARS = 300;

/** Engine-raised programming errors: these indicate a code defect, not bad input. */
const PROGRAMMING_ERRORS = new Set([
  "TypeError",
  "ReferenceError",
  "RangeError",
  "EvalError",
  "URIError",
  "AssertionError",
]);

/** Error classes DevIntern throws for expected, non-defect outcomes. */
const TASK_ERROR_NAMES = new Set([
  "UsageLimitError",
  "HarnessUnavailableError",
  "AbortError",
  "TimeoutError",
]);

/** Message shapes that point at the task, the repository, or the environment. */
const TASK_MESSAGE_PATTERNS: RegExp[] = [
  /\b(?:401|403|404|408|409|422|429|500|502|503|504)\b/,
  /\b(?:unauthori[sz]ed|forbidden|not found|rate.?limit|quota|usage limit)\b/i,
  /\b(?:credential|api token|access token|authenticat|permission denied|EACCES|EPERM)\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENOSPC|fetch failed|network|socket hang up)\b/i,
  /\b(?:merge conflict|non-fast-forward|nothing to commit)\b/i,
  /\b(?:CONFLICT|rejected)\b/,
  /\b(?:exited with code|exit code|killed|SIGTERM|SIGKILL|timed out|timeout)\b/i,
  /\b(?:verification failed|tests? failed|lint failed|typecheck failed|implementation incomplete)\b/i,
  /\b(?:not configured|missing (?:required )?(?:env|environment|setting|config)|is required)\b/i,
];

let cachedRoot: string | null | undefined;

/**
 * Locate the installed `@getdevintern/code` package root by walking up from
 * this module. Works for the source tree (`src/lib/report`) and the bundle
 * (`dist/`), and for global installs under `node_modules`.
 */
export function resolveDevInternPackageRoot(startDir: string = import.meta.dir): string | null {
  if (cachedRoot !== undefined && startDir === import.meta.dir) return cachedRoot;
  let current = startDir;
  let found: string | null = null;
  for (;;) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === "@getdevintern/code") {
          found = current;
          break;
        }
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (startDir === import.meta.dir) cachedRoot = found;
  return found;
}

/** Whether this module is running from the published bundle, not `src/`. */
const RUNNING_FROM_BUNDLE = !/\.tsx?$/.test(import.meta.path);

/** Shared monorepo packages bundled into DevIntern Code. */
const SHARED_PACKAGES = new Set([
  "agent-harness",
  "auth",
  "license-check",
  "license-policy",
  "text-formatter",
  "utils",
  "task-trackers",
]);
const SHARED_PACKAGE_PATTERN =
  /[\\/](?:node_modules[\\/]@devintern|packages)[\\/](agent-harness|auth|license-check|license-policy|text-formatter|utils|task-trackers)[\\/](.+)$/;

/** Unmapped frame inside the bundle: DevIntern and vendored code are indistinguishable. */
const BUNDLE_FRAME = Symbol("bundle-frame");

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isInside(rel: string): boolean {
  return Boolean(rel) && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/**
 * Map an absolute frame path to a package-relative DevIntern path, null for
 * code DevIntern does not own, or {@link BUNDLE_FRAME} for an unmapped bundle.
 */
function devInternRelativePath(
  file: string,
  packageRoot: string | null,
): string | typeof BUNDLE_FRAME | null {
  if (packageRoot) {
    const rel = relative(packageRoot, file);
    if (isInside(rel)) {
      if (rel.includes("node_modules")) return null;
      const posix = toPosix(rel);
      return posix.startsWith("dist/") ? BUNDLE_FRAME : posix;
    }
    // Shared packages resolve to siblings of the package root: `packages/<name>`
    // in the monorepo, and the same relative location once installed, because
    // the bundle's source map records them as `../../<name>/src/...`.
    const siblingRel = relative(dirname(packageRoot), file);
    if (isInside(siblingRel) && !siblingRel.includes("node_modules")) {
      const [name, ...rest] = toPosix(siblingRel).split("/");
      if (name && SHARED_PACKAGES.has(name) && rest.length > 0) return `${name}/${rest.join("/")}`;
    }
  }
  const shared = SHARED_PACKAGE_PATTERN.exec(file);
  if (shared && !shared[2].includes("node_modules")) {
    return `${shared[1]}/${toPosix(shared[2])}`;
  }
  return null;
}

const FRAME_PATTERN = /^\s*at\s+(?:(?:async\s+)?(.+?)\s+\()?(.+?):(\d+)(?::\d+)?\)?\s*$/;

/** Parse V8/JavaScriptCore stack lines into DevIntern-owned frames. */
export function devInternFrames(
  stack: string | undefined,
  packageRoot: string | null,
  options: { minifiedNames?: boolean } = {},
): { frames: DevInternFrame[]; innermostIsDevIntern: boolean; innermostIsBundle: boolean } {
  const frames: DevInternFrame[] = [];
  let innermostIsDevIntern = false;
  let innermostIsBundle = false;
  let sawApplicationFrame = false;
  for (const line of (stack ?? "").split("\n")) {
    const match = FRAME_PATTERN.exec(line);
    if (!match) continue;
    const [, fnRaw, fileRaw, lineRaw] = match;
    const file = fileRaw.replace(/^file:\/\//, "");
    // Runtime-internal frames (`native`, `node:internal/...`) carry no attribution.
    if (!file.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(file)) continue;
    const rel = devInternRelativePath(file, packageRoot);
    if (!sawApplicationFrame) {
      sawApplicationFrame = true;
      innermostIsBundle = rel === BUNDLE_FRAME;
      innermostIsDevIntern = typeof rel === "string";
    }
    if (typeof rel !== "string" || frames.length >= MAX_FRAMES) continue;
    const fn = options.minifiedNames ? undefined : fnRaw?.trim();
    frames.push({
      ...(fn && /^[\w$.<>[\]\s]{1,80}$/.test(fn) ? { fn } : {}),
      file: rel,
      line: Number(lineRaw),
    });
  }
  return { frames, innermostIsDevIntern, innermostIsBundle };
}

/**
 * Remove anything from an error message that could carry task content:
 * quoted free text, long literals, paths, task keys, emails, and secrets.
 * Short identifier-like quotes (`reading 'summary'`) are code, and kept.
 */
export function sanitizeErrorMessage(
  message: string,
  options: Pick<AnalyzeFailureOptions, "cwd" | "homeDir"> = {},
): string {
  const firstLine = (message ?? "").split("\n")[0] ?? "";
  const unquoted = firstLine
    .replace(/(["'`])((?:(?!\1).)*)\1/g, (whole, _quote: string, inner: string) =>
      /^[\w$.[\]()?]{1,60}$/.test(inner) ? whole : "<value>",
    )
    .replace(/\b\S{81,}\b/g, "<value>");
  return redactReportText(unquoted, {
    cwd: options.cwd,
    homeDir: options.homeDir,
    maxChars: MAX_MESSAGE_CHARS,
  }).trim();
}

/**
 * Strip code expressions from a programming error's message before matching
 * task patterns, so `x.timeout is not a function` or JSC's
 * `(evaluating 'res.notFound')` is not mistaken for a timeout or a 404.
 */
function messageProse(message: string): string {
  return message
    .replace(/(["'`])(?:(?!\1).)*\1/g, " ")
    .replace(/[\w$]+(?:(?:\?\.|\.)[\w$]+|\[[^\]]*\]|\(\))+/g, " ")
    .replace(/^\s*[\w$]+(?=\s+is\s+(?:not|undefined|null)\b)/, " ");
}

/** Message reduced to its stable shape for duplicate detection across releases. */
function signatureMessage(message: string): string {
  return message
    .replace(/(["'`])(?:(?!\1).)*\1/g, "<expr>")
    .replace(/[\w$]+(?:(?:\?\.|\.)[\w$]+)+/g, "<expr>")
    .replace(/\d+/g, "<n>");
}

/** Read `name`/`message`/`stack` from an unknown thrown value. */
function errorParts(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || error.constructor?.name || "Error",
      message: error.message,
      stack: error.stack,
    };
  }
  return { name: "NonError", message: typeof error === "string" ? error : "" };
}

/** Whether the error carries a transport/HTTP status (a remote service answered). */
function hasRemoteStatus(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return typeof record.status === "number" || typeof record.statusCode === "number";
}

/**
 * Classify a failed task run's error.
 *
 * @param error - The value the task pipeline caught
 * @param options - Package root, redaction paths, and the failed step
 */
export function analyzeFailure(
  error: unknown,
  options: AnalyzeFailureOptions = {},
): FailureAnalysis {
  const { name, message, stack } = errorParts(error);
  const packageRoot =
    options.packageRoot === undefined ? resolveDevInternPackageRoot() : options.packageRoot;

  if (TASK_ERROR_NAMES.has(name) || hasRemoteStatus(error)) {
    return { verdict: "task", rationale: `${name} is an expected task or environment outcome` };
  }
  // Engine-raised errors name code (`x.timeout is not a function`); only their
  // prose can point at the environment (`fetch failed`).
  const matchable = PROGRAMMING_ERRORS.has(name) ? messageProse(message) : message;
  if (TASK_MESSAGE_PATTERNS.some((pattern) => pattern.test(matchable))) {
    return {
      verdict: "task",
      rationale: "the error points at the task, repository, credentials, or network",
    };
  }
  if (!PROGRAMMING_ERRORS.has(name)) {
    return {
      verdict: "inconclusive",
      rationale: `${name === "NonError" ? "a non-Error value" : name} does not identify a DevIntern defect`,
    };
  }

  const { frames, innermostIsDevIntern, innermostIsBundle } = devInternFrames(stack, packageRoot, {
    minifiedNames: options.minifiedNames ?? RUNNING_FROM_BUNDLE,
  });
  if (innermostIsBundle) {
    return {
      verdict: "inconclusive",
      rationale: `${name} was raised in the bundle without a source map, so its origin is unknown`,
    };
  }
  if (!innermostIsDevIntern || frames.length === 0) {
    return {
      verdict: "inconclusive",
      rationale: `${name} was raised outside DevIntern's own code`,
    };
  }

  const sanitized = sanitizeErrorMessage(message, options);
  const top = frames[0];
  // Source file, error shape, and step only: no line numbers or function
  // names, which move between releases and would re-report the same defect.
  const signature = buildFingerprint({
    title: `${name} ${top.file}`,
    errorName: name,
    errorMessage: signatureMessage(sanitized),
    ...(options.failedStep ? { failedStep: options.failedStep } : {}),
  });
  return {
    verdict: "defect",
    rationale: `${name} raised inside DevIntern (${top.file})`,
    errorName: name,
    message: sanitized,
    frames,
    signature,
  };
}

/** Render a frame as `fn (file:line)`. */
export function formatFrame(frame: DevInternFrame): string {
  const location = frame.line ? `${frame.file}:${frame.line}` : frame.file;
  return frame.fn ? `${frame.fn} (${location})` : location;
}

/**
 * Issue title and body for a defect verdict. Contains only DevIntern-specific
 * facts: error class, sanitized message, DevIntern stack frames, and the
 * failed step. Environment metadata is added by the report payload.
 */
export function describeDefect(
  analysis: FailureAnalysis,
  context: { failedStep?: string; cliVersion?: string } = {},
): { title: string; description: string } {
  const top = analysis.frames?.[0];
  const where = top?.fn ?? top?.file ?? "DevIntern";
  const title = `[auto] ${analysis.errorName ?? "Error"} in ${where}: ${analysis.message ?? ""}`
    .trim()
    .slice(0, 200);
  const lines = [
    "Automatically reported after a failed task run. DevIntern raised an unhandled programming error in its own code.",
    "",
    "## Defect",
    `- Error: ${analysis.errorName ?? "Error"}: ${analysis.message ?? ""}`,
    ...(context.failedStep ? [`- Failed step: ${context.failedStep}`] : []),
    ...(context.cliVersion ? [`- DevIntern version: ${context.cliVersion}`] : []),
    "",
    "## Impact",
    "The task run stopped and was marked failed; no pull request was opened by this attempt.",
    "",
    "## DevIntern stack",
    "```",
    ...(analysis.frames ?? []).map(formatFrame),
    "```",
    "",
    "Task content, logs, prompts, repository details, and credentials are intentionally omitted.",
  ];
  return { title, description: lines.join("\n") };
}
