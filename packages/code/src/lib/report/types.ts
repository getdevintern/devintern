/**
 * Types for user-submitted bug reports.
 *
 * The payload is deliberately narrow: environment metadata, an optional run
 * summary, and bounded logs. Task descriptions, prompts, diffs, environment
 * values, and credentials are never represented here.
 */

/** Where a report came from. */
export type ReportSource = "cli" | "auto" | "pipeline";

/** Automatic-report policy configured per project. */
export type AutoReportMode = "off" | "internal" | "all";

export interface ReportRuntimeInfo {
  bun?: string;
  node?: string;
  os: string;
  arch: string;
  ci: boolean;
}

export interface ReportHarnessInfo {
  name: string;
  version?: string;
}

export interface ReportEnvironment {
  cliVersion: string;
  installKind: string;
  runtime: ReportRuntimeInfo;
  harness?: ReportHarnessInfo;
  tracker?: string;
  sandbox?: string;
  signedIn: boolean;
  telemetry: boolean;
}

export interface ReportRunStage {
  stage: string;
  status: string;
  summary?: string;
}

export interface ReportRunSummary {
  id?: number;
  taskKey?: string;
  status: string;
  origin?: string;
  failedStep?: string;
  haltKind?: "incomplete" | "stop" | "noop";
  reason?: string;
  startedAt?: string;
  durationMs?: number;
  stages: ReportRunStage[];
}

export interface ReportLogAttachment {
  source: string;
  lines: number;
  text: string;
  truncated?: boolean;
}

export interface ReportEvidence {
  key: string;
  title?: string;
  mediaType?: string;
  text: string;
}

export interface ReportContext {
  command?: string;
  pipelineScope?: string;
  pipelineSteps?: string[];
  run?: ReportRunSummary;
  logs?: ReportLogAttachment[];
  evidence?: ReportEvidence[];
}

export interface BugReportPayload {
  schema: 1;
  reportId: string;
  createdAt: string;
  source: ReportSource;
  title: string;
  description: string;
  contact?: { email?: string; signedIn: boolean };
  environment: ReportEnvironment;
  context?: ReportContext;
  fingerprint: string;
  userAgent: string;
}

/** What a caller supplies; preparation adds identity, diagnostics, and caps. */
export interface BugReportDraft {
  title: string;
  description: string;
  source?: ReportSource;
  /** Attach the most recent non-successful run. */
  last?: boolean;
  /** Attach a specific local run id. */
  runId?: number;
  /** Attach the latest local run for this task key. */
  taskKey?: string;
  /** Extra log files (tailed and redacted). */
  logPaths?: string[];
  /** Collect environment/run context. Default true. */
  diagnostics?: boolean;
  /** Include log text. Default true for manual reports. */
  logs?: boolean;
  /** Include the task key and repository slug. Default false. */
  shareIdentifiers?: boolean;
  /** Contact address for anonymous reports. */
  contactEmail?: string;
  /** Caller-supplied structured evidence, capped at 16 KB per item. */
  evidence?: ReportEvidence[];
  /** Command that triggered the failure, for automatic reports. */
  command?: string;
}

export interface PreparedReport {
  payload: BugReportPayload;
  /** Serialized payload size in bytes. */
  bytes: number;
}

export interface SubmittedReport {
  id: string;
  url?: string;
  receipt?: string;
}

export interface BugReporterOptions {
  /** Submission endpoint; defaults to `DEVINTERN_REPORT_URL` or devintern.com. */
  endpoint?: string;
  /** Supabase access token for signed-in reports. */
  accessToken?: string;
  /** Whether the caller is signed in (controls the contact block). */
  signedIn?: boolean;
  /** CLI version shown to maintainers. */
  cliVersion?: string;
  /** Install kind ("bun-global", "npm-global", "local", ...). */
  installKind?: string;
  /** Working directory used for redaction and run lookup. */
  cwd?: string;
  /** Config directory used for run lookup and logs. */
  configDir?: string;
  /** Address for anonymous reports (required server-side). */
  contactEmail?: string;
  /** Injectable fetch for tests and self-hosted transports. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Submission timeout. Default 10 seconds. */
  timeoutMs?: number;
}

export interface BugReporter {
  prepare(draft: BugReportDraft): Promise<PreparedReport>;
  submit(draft: BugReportDraft): Promise<SubmittedReport>;
  submitPrepared(prepared: PreparedReport): Promise<SubmittedReport>;
}

export interface RunDiagnostics {
  run: ReportRunSummary | null;
  logs: ReportLogAttachment[];
}
