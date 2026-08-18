/**
 * Launch-time required-tool check for PM Desktop.
 *
 * Required: Git (clone / fetch / update) and at least one supported agent
 * harness CLI (story generate / edit / decompose). Optional tools are
 * reported as warnings and never block the app.
 */

export type RequiredToolId = "git" | "agent-harness";

/** One required or optional tool probed against the same PATH the app uses to spawn. */
export interface ToolCheck {
  id: RequiredToolId | string;
  /** Short label shown in the gate, e.g. "Git" or "Agent CLI". */
  label: string;
  required: boolean;
  found: boolean;
  /** Resolved path or found harness names. */
  detail?: string;
  /** Actionable install / PATH hint when missing. */
  hint?: string;
  /** Optional download / install page when steps are non-obvious. */
  docsUrl?: string;
}

export interface InstalledHarnessSummary {
  name: string;
  displayName: string;
}

/** Result of {@link validateRequiredTools} — renderer + main share this shape. */
export interface ToolValidation {
  /** True when every required tool is available. */
  ok: boolean;
  tools: ToolCheck[];
  /** Non-blocking findings. Empty when there is nothing to warn about. */
  warnings: string[];
  installedHarnesses: InstalledHarnessSummary[];
}

/** Public Git downloads page — used when Git is missing. */
export const GIT_DOWNLOAD_URL = "https://git-scm.com/downloads";

/** Well-known harness ids used as install examples (must exist in the registry). */
export const EXAMPLE_HARNESS_IDS = ["claude-code", "opencode", "codex", "cursor"] as const;

export function gitInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return "Install Git and make sure it is on your PATH. On macOS: `xcode-select --install` or `brew install git`.";
  }
  if (platform === "win32") {
    return `Install Git and make sure it is on your PATH. Download it from ${GIT_DOWNLOAD_URL}.`;
  }
  return "Install Git and make sure it is on your PATH. On Linux: `sudo apt install git` or `sudo dnf install git`.";
}

export interface HarnessHintSource {
  name: string;
  displayName: string;
  defaultPath: string;
}

/**
 * Compact install guidance naming at least one supported agent CLI.
 * Prefers well-known examples that exist in `sources`; falls back to the
 * full registry so the copy cannot advertise a removed harness.
 */
export function harnessInstallHint(sources: readonly HarnessHintSource[]): string {
  const byName = new Map(sources.map((h) => [h.name, h]));
  const examples = EXAMPLE_HARNESS_IDS.map((id) => byName.get(id)).filter(
    (h): h is HarnessHintSource => h !== undefined,
  );
  const listed = examples.length > 0 ? examples : sources.slice(0, 4);
  const exampleText = listed.map((h) => `${h.displayName} (\`${h.defaultPath}\`)`).join(", ");
  const more = sources.length > listed.length ? ", and others" : "";
  return (
    `Install at least one supported agent CLI${exampleText ? ` (for example ${exampleText}${more})` : ""} ` +
    "and make sure it is on your PATH. " +
    "GUI launches also look in ~/.local/bin, ~/.bun/bin, Homebrew, and similar locations. " +
    "You can set AGENT_CLI_PATH or <HARNESS>_CLI_PATH if the executable lives elsewhere."
  );
}

/** True when the user must fix their machine before opening a project. */
export function isToolValidationBlocking(result: ToolValidation | null | undefined): boolean {
  return result !== null && result !== undefined && !result.ok;
}
