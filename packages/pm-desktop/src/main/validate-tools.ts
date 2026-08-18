/**
 * Probe Git and supported agent harness CLIs using the same PATH the app
 * uses to spawn agents (including {@link augmentPath} GUI PATH fixes).
 */

import { spawnSync } from "node:child_process";
import {
  findInPath,
  getHarness,
  listHarnesses,
  listInstalledHarnesses,
} from "@devintern/agent-harness";
import type { AgentHarness, ListInstalledHarnessesOptions } from "@devintern/agent-harness";
import { GIT_DOWNLOAD_URL, gitInstallHint, harnessInstallHint } from "../shared/tool-validation.ts";
import type { ToolCheck, ToolValidation } from "../shared/tool-validation.ts";
import { augmentPath } from "./path-fix.ts";

export interface ValidateToolsDeps {
  augmentPath?: () => void;
  findGit?: () => string | null;
  probeGit?: (path: string) => boolean;
  listInstalled?: (options?: ListInstalledHarnessesOptions) => readonly AgentHarness[];
  listAll?: () => readonly AgentHarness[];
  envOverrides?: Readonly<Record<string, string>>;
  platform?: NodeJS.Platform;
}

function probeGit(path: string): boolean {
  const result = spawnSync(path, ["--version"], {
    env: process.env,
    stdio: "ignore",
    timeout: 3_000,
  });
  return result.status === 0;
}

/** Apply project-local agent settings only for the duration of a synchronous probe. */
function withEnvOverrides<T>(overrides: Readonly<Record<string, string>>, probe: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return probe();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

  const gitCandidate = (deps.findGit ?? (() => findInPath("git")))();
  const gitPath = gitCandidate && (deps.probeGit ?? probeGit)(gitCandidate) ? gitCandidate : null;
  const installed = withEnvOverrides(deps.envOverrides ?? {}, () => {
    const configuredHarnessName = process.env.AGENT_HARNESS ?? "claude-code";
    const currentHarnessName = getHarness(configuredHarnessName)?.name ?? configuredHarnessName;
    return [
      ...(deps.listInstalled ?? ((options) => listInstalledHarnesses(options)))({
        currentHarnessName,
      }),
    ];
  });
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
