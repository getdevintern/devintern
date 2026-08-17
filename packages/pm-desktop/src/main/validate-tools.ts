/**
 * Probe Git and supported agent harness CLIs using the same PATH the app
 * uses to spawn agents (including {@link augmentPath} GUI PATH fixes).
 */

import { findInPath, listHarnesses, listInstalledHarnesses } from "@devintern/agent-harness";
import type { AgentHarness } from "@devintern/agent-harness";
import { GIT_DOWNLOAD_URL, gitInstallHint, harnessInstallHint } from "../shared/tool-validation.ts";
import type { ToolCheck, ToolValidation } from "../shared/tool-validation.ts";
import { augmentPath } from "./path-fix.ts";

export interface ValidateToolsDeps {
  augmentPath?: () => void;
  findGit?: () => string | null;
  listInstalled?: () => readonly AgentHarness[];
  listAll?: () => readonly AgentHarness[];
  platform?: NodeJS.Platform;
}

function toHintSource(harness: AgentHarness): {
  name: string;
  displayName: string;
  defaultPath: string;
} {
  return {
    name: harness.name,
    displayName: harness.displayName,
    defaultPath: harness.defaultPath,
  };
}

/**
 * Re-apply GUI PATH augmentation, then check required tools.
 *
 * Re-running {@link augmentPath} on each check picks up install dirs that
 * appeared after launch (e.g. the user just created `~/.local/bin`).
 */
export function validateRequiredTools(deps: ValidateToolsDeps = {}): ToolValidation {
  (deps.augmentPath ?? augmentPath)();

  const gitPath = (deps.findGit ?? (() => findInPath("git")))();
  const installed = [...(deps.listInstalled ?? (() => listInstalledHarnesses()))()];
  const registry = [...(deps.listAll ?? (() => listHarnesses()))()];
  const platform = deps.platform ?? process.platform;

  const git: ToolCheck = gitPath
    ? {
        id: "git",
        label: "Git",
        required: true,
        found: true,
        detail: gitPath,
      }
    : {
        id: "git",
        label: "Git",
        required: true,
        found: false,
        hint: gitInstallHint(platform),
        docsUrl: GIT_DOWNLOAD_URL,
      };

  const harness: ToolCheck =
    installed.length > 0
      ? {
          id: "agent-harness",
          label: "Agent CLI",
          required: true,
          found: true,
          detail: installed.map((h) => h.displayName).join(", "),
        }
      : {
          id: "agent-harness",
          label: "Agent CLI",
          required: true,
          found: false,
          hint: harnessInstallHint(registry.map(toHintSource)),
        };

  return {
    ok: git.found && harness.found,
    tools: [git, harness],
    warnings: [],
    installedHarnesses: installed.map((h) => ({
      name: h.name,
      displayName: h.displayName,
    })),
  };
}
