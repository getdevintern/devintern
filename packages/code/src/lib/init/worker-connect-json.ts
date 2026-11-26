/**
 * `devintern worker connect --json`: one machine-readable document on stdout
 * (schema `devintern.worker-connect`, version 1); human text goes to stderr.
 */

import { OTHER_LOGIN_METHODS } from "../account/worker-pilot";
import { pairingNextUrl } from "../relay/github-pairing";
import type { ConnectOutcome } from "../relay/connect";
import { takeoverCommand } from "../relay/worker-identity";
import type { SentryMonitorReport } from "./worker-sentry-noninteractive";

export const CONNECT_JSON_SCHEMA = "devintern.worker-connect";
export const CONNECT_JSON_VERSION = 1;

/** `connected` and `pending` exit 0, `action_required` exits 2, `failure` exits 1. */
export type ConnectJsonResult = "connected" | "pending" | "action_required" | "failure";

/**
 * One step, the shared next-step shape (`id`, `message`, `command`): `command`
 * is the command to run on the worker host, or the address to open when the
 * step needs a person in a browser (then `url` repeats it).
 */
export interface ConnectNextStep {
  id: string;
  message: string;
  command: string;
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

/** A registration another worker on the account serves. */
export interface ConnectConflictJson {
  kind: "repo" | "source" | "code-host";
  key: string;
  team?: string;
  ownerWorkerId: string;
  ownerLabel: string;
  /** ISO timestamp of the owning worker's last relay poll. */
  lastSeenAt: string;
}

export interface ConnectTargetJson {
  target: string;
  result: ConnectJsonResult;
  error?: string;
  code?: string;
  /** This workspace's relay worker identity, when the relay supports per-worker routing. */
  workerId?: string;
  /** With `code: registration_owned_by_other_worker`: who serves each registration. */
  conflicts?: ConnectConflictJson[];
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
  /** With several targets: every target's steps, in order, without duplicates. */
  nextSteps?: ConnectNextStep[];
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
  /** Relay worker id after the run, when registered. */
  workerId?: string;
}

/** Describe what one connect target did. */
export function buildTargetDocument(input: TargetDocumentInput): ConnectTargetJson {
  const doc = describeTarget(input);
  return input.workerId ? { ...doc, workerId: input.workerId } : doc;
}

function describeTarget(input: TargetDocumentInput): ConnectTargetJson {
  const { target, outcomes } = input;
  const signedOut = outcomes.find((outcome) => outcome.kind === "not_signed_in");
  if (signedOut && signedOut.kind === "not_signed_in") {
    return {
      target,
      result: "action_required",
      error: signedOut.error,
      code: "not_signed_in",
      nextSteps: [
        {
          id: "sign-in",
          message:
            `Sign in first, then run connect again. The command prints a sign-in url for a person ` +
            `to open and the --complete command to finish on this host. Other methods: ${OTHER_LOGIN_METHODS}`,
          command: `devintern worker login${input.workspaceSuffix} github --no-wait --json`,
        },
      ],
    };
  }
  const failed = outcomes.find((outcome) => outcome.kind === "failed");
  if (failed && failed.kind === "failed") {
    const conflicts = failed.conflicts ?? [];
    return {
      target,
      result: "failure",
      error: failed.error,
      code: failed.code ?? "connect_failed",
      ...(conflicts.length > 0
        ? {
            conflicts: conflicts.map((conflict) => ({
              kind: conflict.kind,
              key: conflict.key,
              ...(conflict.team ? { team: conflict.team } : {}),
              ownerWorkerId: conflict.ownerWorkerId,
              ownerLabel: conflict.ownerLabel,
              lastSeenAt: new Date(conflict.lastSeenAt).toISOString(),
            })),
            nextSteps: [
              {
                id: "takeover",
                message:
                  "Another worker owns these registrations. Move them to this worker only when that worker is retired or should stop receiving these events",
                command: `${takeoverCommand(conflicts[0]!)} --json${input.workspaceSuffix}`,
              },
            ],
          }
        : {}),
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
        {
          id: "authorize-github-app",
          message:
            "A person opens this address and approves the DevIntern GitHub App for the listed repositories",
          command: pairingNextUrl(pairing),
          url: pairingNextUrl(pairing),
        },
        {
          id: "check-pairing",
          message: "After the approval, confirm the pairing (exit 0 once connected)",
          command: `devintern worker connect github --status --json${input.workspaceSuffix}`,
        },
      ],
    };
  }
  if (input.exitCode !== 0) {
    return {
      target,
      result: "failure",
      code: "connect_failed",
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
    return {
      ...base,
      target,
      result: "failure",
      code: "nothing_connected",
      error: "Nothing was connected.",
    };
  }
  const nextSteps: ConnectNextStep[] = [];
  for (const step of docs.flatMap((doc) => doc.nextSteps ?? [])) {
    if (!nextSteps.some((s) => s.id === step.id && s.command === step.command)) {
      nextSteps.push(step);
    }
  }
  return {
    ...base,
    target,
    result: aggregateResult(docs),
    ...(nextSteps.length > 0 ? { nextSteps } : {}),
    targets: docs,
  };
}
