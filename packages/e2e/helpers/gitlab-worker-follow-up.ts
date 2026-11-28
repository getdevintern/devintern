/**
 * Shared wiring for offline `devintern worker` GitLab follow-up tests
 * (conflict resolution, CI repair, relay hints) against a
 * {@link import("./fake-gitlab-forge").FakeGitlabForge}.
 *
 * The forge serves the GitLab API, and git fetch/push are rewritten onto the
 * fixture's local bare repository, so no request leaves the machine.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { WorkerFixture } from "./worker";

/** Quote a string for a POSIX single-quoted shell literal. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Put a logging `git` wrapper first on the worker's PATH and rewrite the
 * forge's clone URL (`httpUrl`) onto the bare repository with `insteadOf`.
 * The credential helper is cleared, signing is off, and hooks are disabled.
 *
 * `git remote get-url` applies `insteadOf` and would show the bare path. The
 * GitLab paths compare that output to the MR project, so the wrapper drops the
 * rewrite only for `get-url`; fetch and push still use it.
 *
 * @returns Path of the log with one line of argv per git call.
 */
export function installGitlabGitRewrite(
  worker: WorkerFixture,
  gitBin: string,
  httpUrl: string,
): string {
  const dir = join(worker.root, "git-bin");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "git-argv.log");
  const wrapper = join(dir, "git");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shQuote(logPath)}`,
      "prev=",
      "strip=0",
      'for arg in "$@"; do',
      '  if [ "$prev" = "remote" ] && [ "$arg" = "get-url" ]; then strip=1; fi',
      "  prev=$arg",
      "done",
      'if [ "$strip" = 1 ]; then',
      "  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 \\",
      "    GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1 GIT_CONFIG_KEY_2 GIT_CONFIG_VALUE_2 \\",
      "    GIT_CONFIG_KEY_3 GIT_CONFIG_VALUE_3",
      "fi",
      `exec ${shQuote(gitBin)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(wrapper, 0o700);
  worker.env.PATH = `${dir}${delimiter}${worker.env.PATH ?? ""}`;
  Object.assign(worker.env, {
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: `url.${worker.remote}.insteadOf`,
    GIT_CONFIG_VALUE_3: httpUrl,
  });
  return logPath;
}

/** Every line the {@link installGitlabGitRewrite} wrapper logged. */
export function gitArgvLines(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

/** `git push` calls in the wrapper log, from line `from` on. */
export function gitPushLines(logPath: string, from = 0): string[] {
  return gitArgvLines(logPath)
    .slice(from)
    .filter((line) => line === "push" || line.startsWith("push "));
}

export interface RegisteredGitlabMergeRequest {
  /** GitLab instance URL the worker talks to (the forge or a proxy in front of it). */
  instanceUrl: string;
  /** `group/project` path of the fixture project (id `1`). */
  projectPath: string;
  /** MR source branch. */
  branch: string;
  /** Registration time; the poller ignores notes older than this. Defaults to now. */
  createdAt?: number;
}

/**
 * Record MR !1 in `agent_prs` the way the worker pipeline registers an MR it
 * opened, so the registered-MR poller and CI watcher start watching it.
 */
export function registerGitlabMergeRequest(
  worker: WorkerFixture,
  mr: RegisteredGitlabMergeRequest,
): void {
  const db = new Database(worker.dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const at = mr.createdAt ?? Date.now();
    db.run(
      `INSERT INTO agent_prs (
         provider, instance_url, project_id, project_path, change_number, web_url,
         repo, pr_number, branch, state, created_at, updated_at
       ) VALUES ('gitlab', ?, '1', ?, 1, ?, ?, 1, ?, 'open', ?, ?)`,
      [
        mr.instanceUrl,
        mr.projectPath,
        `${mr.instanceUrl}/${mr.projectPath}/-/merge_requests/1`,
        mr.projectPath,
        mr.branch,
        at,
        at,
      ],
    );
  } finally {
    db.close();
  }
}
