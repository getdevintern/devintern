/**
 * Reuse a signed-in GitHub CLI (`gh`) session when `GITHUB_TOKEN` is not set.
 *
 * A token copied from `gh` is ordinary `GITHUB_TOKEN` credentials: it is
 * validated with the same probe as a pasted token before setup saves it, and
 * the saved value is a copy that does not follow later `gh auth login` runs.
 */

import { spawnSync } from "child_process";

/** Where a run's `GITHUB_TOKEN` came from. Never a token value. */
export type GitHubTokenSource = "env" | "env-file" | "gh";

/** One reusable GitHub CLI token plus what the CLI says about the session. */
export interface GitHubCliToken {
  token: string;
  /** Signed-in account login, when `gh auth status` names it. */
  account?: string;
  /** Token scopes as `gh` prints them, when available. */
  scopes?: string;
}

/** Injectable process access for tests. */
export interface GitHubCliDeps {
  /** Finds an executable on PATH; defaults to `Bun.which` over {@link env}. */
  which?: (command: string) => string | null;
  /** Runs a command; defaults to `spawnSync` with {@link env}. */
  run?: (
    command: string,
    args: string[],
  ) => { status: number | null; stdout: string; stderr: string };
  /** Environment for PATH lookup and the commands; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse the account and scopes out of `gh auth status` output.
 *
 * Handles both the `Logged in to github.com account <login>` wording and the
 * older `Logged in to github.com as <login>` one; output may be on either
 * stream depending on the `gh` version.
 */
export function parseGitHubCliStatus(text: string): {
  account?: string;
  scopes?: string;
} {
  const account = /\baccount\s+([^\s(]+)/i.exec(text)?.[1] ?? /\bas\s+([^\s(]+)/i.exec(text)?.[1];
  const rawScopes = /Token scopes:\s*(.+)/i.exec(text)?.[1]?.trim();
  const scopes = rawScopes?.replace(/^['"]|['"]$/g, "").replace(/['"]\s*,\s*['"]/g, ", ");
  return {
    ...(account ? { account } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

/** Bound `gh` so a stuck CLI cannot stall setup. */
const GH_TIMEOUT_MS = 5_000;

/** True when `gh` is on PATH and `gh auth token` returns a non-empty token. */
export function readGitHubCliToken(deps: GitHubCliDeps = {}): GitHubCliToken | null {
  const env = deps.env ?? process.env;
  const which =
    deps.which ??
    ((command: string) =>
      Bun.which(command, env.PATH !== undefined ? { PATH: env.PATH } : undefined));
  const run =
    deps.run ??
    ((command: string, args: string[]) => {
      const result = spawnSync(command, args, {
        env,
        encoding: "utf8",
        timeout: GH_TIMEOUT_MS,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    });

  if (!which("gh")) return null;
  // `gh auth token` prints the token on stdout; never log or include errors.
  const tokenResult = run("gh", ["auth", "token"]);
  const token = tokenResult.status === 0 ? tokenResult.stdout.trim() : "";
  if (!token) return null;
  const status = run("gh", ["auth", "status"]);
  const details = parseGitHubCliStatus(`${status.stdout}\n${status.stderr}`);
  return { token, ...details };
}

/** One-line session description for the reuse prompt (account and scopes, never the token). */
export function describeGitHubCliToken(token: GitHubCliToken): string {
  const account = token.account ? `account ${token.account}` : "account unknown";
  const scopes = token.scopes ? `scopes ${token.scopes}` : "scopes unavailable";
  return `${account}, ${scopes}`;
}
