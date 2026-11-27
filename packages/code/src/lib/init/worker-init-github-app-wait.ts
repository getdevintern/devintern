/**
 * The wizard's wait for the DevIntern GitHub App: after relay pairing started
 * a GitHub pairing, open (or print) the install/authorize address and check
 * the pairing until it completes, expires, or the user presses Enter to finish
 * later. Mirrors the sign-in wait, which also waits for the browser and lets
 * Enter skip.
 */

import { isRemoteCliSession, openBrowser, watchStdinLines } from "@devintern/auth";

import { isPromptAbort } from "../cli/prompt-abort";
import {
  clearPendingGitHubPairing,
  describeGitHubPairingFailure,
  isTransientPairingFailure,
  pairingNextUrl,
  pollGitHubPairing,
} from "../relay/github-pairing";
import type { GitHubPairingPoll, PendingGitHubPairing } from "../relay/github-pairing";
import { loadRelayState } from "../relay/state";
import type { LogFn } from "./worker-init-policy";

/** `installed`: the relay verified the App; anything else leaves the pairing to finish later. */
export type GitHubAppWaitResult = "installed" | "skipped" | "expired" | "failed";

/** A running Enter-to-skip listener. */
export interface SkipWatch {
  /** Resolves when the user asks to stop waiting. */
  skipped: Promise<void>;
  stop: () => void;
}

/** Injectable parts of the wait (tests). */
export interface GitHubAppWaitDeps {
  /** Open the address in a browser (default: the system browser, skipped over SSH). */
  openUrl?: (url: string) => Promise<void>;
  /** Start listening for Enter (default: stdin lines). */
  watchSkip?: () => SkipWatch;
  /** Check the pairing once (default: the relay pairing status). */
  poll?: (pairing: PendingGitHubPairing) => Promise<GitHubPairingPoll>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Seconds between pairing checks. */
const POLL_INTERVAL_MS = 2000;

/** Command that finishes a pairing left waiting. */
export const FINISH_GITHUB_PAIRING_COMMAND = "devintern worker connect github --status";

function defaultWatchSkip(): SkipWatch {
  let resolveSkip: () => void = () => {};
  const skipped = new Promise<void>((resolve) => {
    resolveSkip = resolve;
  });
  const stop = watchStdinLines(() => resolveSkip());
  return { skipped, stop };
}

/**
 * Wait for the GitHub App installation of a started pairing.
 *
 * @param options.guard - Turns Ctrl+C during the wait into a prompt abort
 * @returns What happened; the pairing stays recorded unless it completed or expired
 */
export async function waitForGitHubAppInstall(
  options: {
    pairing: PendingGitHubPairing;
    /** The signed-in session's access token, for the pairing checks. */
    getAccessToken: () => Promise<string>;
    workspaceDir: string;
    log: LogFn;
    guard?: <T>(work: Promise<T>) => Promise<T>;
  },
  deps: GitHubAppWaitDeps = {},
): Promise<GitHubAppWaitResult> {
  const { pairing, getAccessToken, workspaceDir, log } = options;
  const url = pairingNextUrl(pairing);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const poll =
    deps.poll ??
    (async (pending: PendingGitHubPairing) =>
      pollGitHubPairing({
        pairing: pending,
        accessToken: await getAccessToken(),
        relayToken: loadRelayState(workspaceDir)?.relayToken,
        workingDir: workspaceDir,
        relayUrl: pending.relayUrl,
      }));

  if (!isRemoteCliSession() || deps.openUrl) {
    try {
      await (deps.openUrl ?? openBrowser)(url);
      log(`   Opened ${url} in your browser.`);
    } catch {
      log(`   Open this address in a browser: ${url}`);
    }
  } else {
    log(`   Open this address in a browser: ${url}`);
  }
  log("⏳ Waiting for the DevIntern GitHub App installation...");
  log(
    `   Press Enter to skip and finish later: approve the App, then run \`${FINISH_GITHUB_PAIRING_COMMAND}\`.`,
  );

  const watch = (deps.watchSkip ?? defaultWatchSkip)();
  let skipped = false;
  void watch.skipped.then(() => {
    skipped = true;
  });
  const guard = options.guard ?? (<T>(work: Promise<T>) => work);
  let pollErrorLogged = false;
  try {
    while (!skipped && now() < pairing.expiresAt) {
      let polled: GitHubPairingPoll;
      try {
        polled = await guard(poll(pairing));
      } catch (error) {
        // Ctrl+C stops setup; a dropped connection or relay hiccup is
        // retried until the pairing expires, like an HTTP 5xx.
        if (isPromptAbort(error)) throw error;
        if (!pollErrorLogged) {
          log(`   Could not check the pairing (${(error as Error).message}); retrying...`);
          pollErrorLogged = true;
        }
        await guard(Promise.race([sleep(POLL_INTERVAL_MS), watch.skipped]));
        continue;
      }
      if (polled.kind === "complete") {
        clearPendingGitHubPairing(workspaceDir);
        log("✅ DevIntern GitHub App installed and verified.");
        return "installed";
      }
      if (polled.kind === "expired") break;
      if (polled.kind === "failure" && !isTransientPairingFailure(polled)) {
        log(`⚠️  ${describeGitHubPairingFailure(polled)}`);
        return "failed";
      }
      await guard(Promise.race([sleep(POLL_INTERVAL_MS), watch.skipped]));
    }
  } finally {
    watch.stop();
  }
  if (skipped) {
    log(
      `⏭️  Skipped. Finish later: approve the App at ${url}, then \`${FINISH_GITHUB_PAIRING_COMMAND}\`.`,
    );
    return "skipped";
  }
  clearPendingGitHubPairing(workspaceDir);
  log("⚠️  The GitHub App pairing expired. Start it again with `devintern worker connect github`.");
  return "expired";
}
