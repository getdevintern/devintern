/**
 * `devintern worker connect --json`: one machine-readable document on stdout
 * (schema `devintern.worker-connect`, version 1); human text goes to stderr.
 */

import { pairingNextUrl } from "../relay/github-pairing";
import type { ConnectOutcome } from "../relay/connect";
import type { SentryMonitorReport } from "./worker-sentry-noninteractive";

export const CONNECT_JSON_SCHEMA = "devintern.worker-connect";
export const CONNECT_JSON_VERSION = 1;

/** `connected` and `pending` exit 0, `action_required` exits 2, `failure` exits 1. */
export type ConnectJsonResult = "connected" | "pending" | "action_required" | "failure";

export interface ConnectNextStep {
  id: string;
  /** Command to run on the worker host. */
  command?: string;
  /** Address to open in a browser. */
  url?: string;
}

export interface ConnectPairingJson {
  id: string;
  state: "pending";
  installUrl: string;
  authorizeUrl?: string;
  appInstalled?: boolean;
  /** ISO timestamp. */
  expiresAt: string;
}

export interface ConnectTargetJson {
  target: string;
  result: ConnectJsonResult;
  error?: string;
  code?: string;
  repos?: string[];
  relayUrl?: string;
  pairing?: ConnectPairingJson;
  monitors?: SentryMonitorReport[];
  warnings?: string[];
  /** Flags or variables that were not supplied. */
  missing?: string[];
  nextSteps?: ConnectNextStep[];
}

export interface ConnectJsonDocument extends Omit<ConnectTargetJson, "target"> {
  schema: typeof CONNECT_JSON_SCHEMA;
  version: typeof CONNECT_JSON_VERSION;
  target: string;
  /** Per-target documents when one command ran several targets (`worker connect`). */
  targets?: ConnectTargetJson[];
}

/** Process exit code for a result. */
export function exitCodeForResult(result: ConnectJsonResult): number {
  if (result === "failure") return 1;
  return result === "action_required" ? 2 : 0;
}

/** The one result that describes several targets: the most urgent one wins. */
export function aggregateResult(docs: ConnectTargetJson[]): ConnectJsonResult {
  for (const result of ["action_required", "failure", "pending"] as const) {
    if (docs.some((doc) => doc.result === result)) return result;
  }
  return "connected";
}

/** Strip the leading status glyph the human output adds to an error line. */
function plainMessage(line: string | undefined): string | undefined {
  return line?.replace(/^\s*(?:❌|⚠️)\s*/u, "").trim() || undefined;
}

export interface TargetDocumentInput {
  target: string;
  exitCode: number;
  outcomes: ConnectOutcome[];
  /** `console.error` lines the target printed. */
  errorLines: string[];
  /** ` --workspace <path>` when the workspace is not the default, else empty. */
  workspaceSuffix: string;
}

/** Describe what one connect target did. */
export function buildTargetDocument(input: TargetDocumentInput): ConnectTargetJson {
  const { target, outcomes } = input;
  const signedOut = outcomes.find((outcome) => outcome.kind === "not_signed_in");
  if (signedOut && signedOut.kind === "not_signed_in") {
    return {
      target,
      result: "action_required",
      error: signedOut.error,
      nextSteps: [
        {
          id: "sign-in",
          command: `devintern worker login <method> --no-wait --json${input.workspaceSuffix}`,
        },
      ],
    };
  }
  const failed = outcomes.find((outcome) => outcome.kind === "failed");
  if (failed && failed.kind === "failed") {
    return {
      target,
      result: "failure",
      error: failed.error,
      ...(failed.code ? { code: failed.code } : {}),
    };
  }
  const pending = outcomes.find((outcome) => outcome.kind === "pending");
  if (pending && pending.kind === "pending") {
    const { pairing } = pending;
    const connected = outcomes.flatMap((outcome) =>
      outcome.kind === "connected" ? (outcome.repos ?? []) : [],
    );
    return {
      target,
      result: "pending",
      ...(connected.length > 0 ? { repos: connected } : {}),
      pairing: {
        id: pairing.id,
        state: "pending",
        installUrl: pairing.installUrl,
        ...(pairing.authorizeUrl ? { authorizeUrl: pairing.authorizeUrl } : {}),
        ...(pairing.authorizeUrl && pairing.appInstalled !== undefined
          ? { appInstalled: pairing.appInstalled }
          : {}),
        expiresAt: new Date(pairing.expiresAt).toISOString(),
      },
      nextSteps: [
        { id: "authorize-github-app", url: pairingNextUrl(pairing) },
        {
          id: "check-pairing",
          command: `devintern worker connect github --status --json${input.workspaceSuffix}`,
        },
      ],
    };
  }
  if (input.exitCode !== 0) {
    return {
      target,
      result: "failure",
      error: plainMessage(input.errorLines.at(-1)) ?? `devintern worker connect ${target} failed.`,
    };
  }
  const repos = outcomes.flatMap((outcome) =>
    outcome.kind === "connected" ? (outcome.repos ?? []) : [],
  );
  const relayUrl = outcomes.find((outcome) => outcome.kind === "connected")?.relayUrl;
  return {
    target,
    result: "connected",
    ...(repos.length > 0 ? { repos } : {}),
    ...(relayUrl ? { relayUrl } : {}),
  };
}

/** Assemble the single stdout document from the per-target documents. */
export function buildConnectDocument(
  target: string,
  docs: ConnectTargetJson[],
): ConnectJsonDocument {
  const base = { schema: CONNECT_JSON_SCHEMA, version: CONNECT_JSON_VERSION } as const;
  if (docs.length === 1 && target !== "all") return { ...base, ...docs[0]! };
  if (docs.length === 0) {
    return { ...base, target, result: "failure", error: "Nothing was connected." };
  }
  return { ...base, target, result: aggregateResult(docs), targets: docs };
}
