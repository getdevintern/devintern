import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export function isolatedEnvironment(root: string): Record<string, string> {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  // Allowlist rather than inherit tracker credentials, prompt overrides, git
  // configuration or the contributor's agent/account settings.
  return {
    PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: root,
    LANG: "C.UTF-8",
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "DevIntern E2E",
    GIT_AUTHOR_EMAIL: "e2e@example.invalid",
    GIT_COMMITTER_NAME: "DevIntern E2E",
    GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    DEVINTERN_WORKSPACE_DIR: join(root, "workspace"),
    DEVINTERN_OUTPUT_DIR: join(root, "output"),
    WEBHOOK_QUEUE_DB: join(root, "queue.db"),
    DEVINTERN_ANALYTICS_CONFIG_DIR: join(root, "analytics"),
    DEVINTERN_SKIP_LICENSE_CHECK: "1",
    DEVINTERN_NO_UPDATE: "1",
    DEVINTERN_TELEMETRY_DISABLED: "1",
    SENTRY_DISABLED: "1",
    TASK_TRACKER: "markdown",
    AGENT_HARNESS: "claude-code",
    AGENT_SANDBOX: "none",
    AGENT_HARNESS_TIMEOUT_MINUTES: "1",
  };
}
