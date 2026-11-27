import { condenseMessage } from "@devintern/task-trackers";

/**
 * Turn a ready-tasks dry-run error into one readable line. A GitHub search
 * the token cannot run (the repository is missing or not granted to it) is a
 * credentials problem, flagged `access` so the wizard does not blame the query.
 *
 * @param message - The error message from the tracker client
 * @param githubRepo - Configured `GITHUB_REPO`, named in the access message
 */
export function describeQueryFailure(
  message: string,
  githubRepo?: string,
): { text: string; access: boolean } {
  const status = /GitHub API error \((\d{3})\)/.exec(message)?.[1];
  const repo = githubRepo || "the repository";
  if (
    status === "422" &&
    /cannot be searched|do not exist or you do not have permission/i.test(message)
  ) {
    return {
      text:
        `GitHub can't search ${repo}: the repository doesn't exist or the token can't see it. ` +
        "Check GITHUB_REPO and the token's repository access.",
      access: true,
    };
  }
  if (status === "401") {
    return {
      text: "GitHub rejected the token (401): it is mistyped, expired, or revoked.",
      access: true,
    };
  }
  // GitHub (and others) append the raw JSON body; keep only its messages.
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    const messages = [...message.slice(jsonStart).matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
      .map((match) => match[1])
      .filter((text): text is string => Boolean(text));
    if (messages.length > 0) {
      const prefix = message.slice(0, jsonStart).replace(/[\s:]+$/, "");
      return {
        text: condenseMessage(`${prefix}: ${[...new Set(messages)].join("; ")}`),
        access: false,
      };
    }
  }
  return { text: condenseMessage(message), access: false };
}

/**
 * What still keeps the worker from running, one line each: the failing
 * readiness checks when they ran, otherwise the license step's result.
 *
 * @param checks - `worker doctor` checks, or undefined when they did not run
 * @param licenseFailure - License step outcome (null when entitled)
 */
