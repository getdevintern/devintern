import { resolve } from "node:path";
import { shell } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-contract.ts";
import type {
  InitializeProjectRequest,
  UpdateProjectTrackerRequest,
} from "../../shared/ipc-contract.ts";
import {
  inspectPmInitContext,
  listPmTrackers,
  probePmConnection,
  writePmProjectConfig,
} from "@getdevintern/pm/init";
import { track } from "../analytics.ts";
import { listProjectBindings } from "../project-bindings.ts";
import { persistTrackerCredentials, readProjectEnv } from "../project-env.ts";
import { removeConnectedProject } from "../remove-connected-project.ts";
import { recordRecentProjectDir } from "../recent-projects.ts";
import { detectGitRepository, getSession, loadProject, switchContext } from "../session.ts";
import { readSettings, updateSettings } from "../settings.ts";
import { handle } from "./register.ts";

/** Reveal only known project dirs (bindings, recents, current session) — not arbitrary paths. */
async function isAllowedRevealPath(resolved: string): Promise<boolean> {
  const session = getSession();
  if (session && resolve(session.projectDir) === resolved) return true;

  const settings = await readSettings();
  if (settings.lastProjectDir && resolve(settings.lastProjectDir) === resolved) return true;
  for (const dir of settings.recentProjectDirs ?? []) {
    if (resolve(dir) === resolved) return true;
  }

  const bindings = await listProjectBindings();
  return bindings.some((b) => resolve(b.localPath) === resolved);
}

/** Project reveal, setup/init, tracker, and recents IPC handlers. */
export function registerProjectIpcHandlers(): void {
  handle(IPC_CHANNELS.revealProjectInFolder, async (_event, dir: unknown) => {
    if (typeof dir !== "string" || dir.trim().length === 0) {
      throw Object.assign(new Error("Invalid project folder."), { code: "invalid_input" });
    }
    const resolved = resolve(dir);
    if (!(await isAllowedRevealPath(resolved))) {
      throw new Error("Can only reveal a known project folder.");
    }
    shell.showItemInFolder(resolved);
    return null;
  });

  handle(IPC_CHANNELS.removeConnectedProject, async (_event, options: unknown) => {
    if (!options || typeof options !== "object") {
      throw Object.assign(new Error("Invalid remove project request."), {
        code: "invalid_input",
      });
    }
    const { localPath, deleteFiles } = options as {
      localPath?: unknown;
      deleteFiles?: unknown;
    };
    if (typeof localPath !== "string" || typeof deleteFiles !== "boolean") {
      throw Object.assign(new Error("Invalid remove project request."), {
        code: "invalid_input",
      });
    }
    await removeConnectedProject({ localPath, deleteFiles });
    return null;
  });

  handle(IPC_CHANNELS.getProjectStatus, async (_event, dir: string) => {
    const status = await loadProject(dir);
    await updateSettings({ lastProjectDir: status.projectDir });
    // Only PM-ready folders (git + .devintern-pm) join the recent menu.
    await recordRecentProjectDir(status.projectDir);

    void track("project_opened", { configured: status.configured });
    if (status.configured) {
      const session = getSession();
      if (session) {
        void track("project_configured", {
          tracker: session.config.backend.type,
          harness: session.config.agent.harness.name,
        });
      }
    }

    return status;
  });

  handle(IPC_CHANNELS.inspectProjectInit, async (_event, dir: string) => {
    const context = await inspectPmInitContext(dir);
    const { env } = await readProjectEnv(dir);
    return { ...context, trackers: listPmTrackers(), currentEnv: env };
  });

  handle(
    IPC_CHANNELS.probeTrackerConnection,
    async (_event, trackerId: string, values: Record<string, string>) => {
      return probePmConnection(trackerId, values);
    },
  );

  handle(IPC_CHANNELS.initializeProject, async (_event, input: InitializeProjectRequest) => {
    // Match loadProject's git gate so we never persist credentials for unsuitable folders.
    if (!detectGitRepository(input.projectDir)) {
      throw new Error(
        "This folder is not a git repository. Choose a git-connected project before setting up PM.",
      );
    }
    await writePmProjectConfig({
      cwd: input.projectDir,
      trackerId: input.trackerId,
      values: input.values,
      overwrite: input.overwrite === true,
    });
    const status = await loadProject(input.projectDir);
    await updateSettings({ lastProjectDir: status.projectDir });
    // Setup writes `.devintern-pm`, so the project is now eligible for recents.
    await recordRecentProjectDir(status.projectDir);
    if (!status.configured) {
      throw new Error(
        status.configError ?? "Configuration was written but the project could not be loaded.",
      );
    }
    return status;
  });

  handle(IPC_CHANNELS.updateProjectTracker, async (_event, input: UpdateProjectTrackerRequest) => {
    if (!input || typeof input !== "object") {
      throw Object.assign(new Error("Invalid update tracker request."), { code: "invalid_input" });
    }
    if (typeof input.projectDir !== "string" || typeof input.trackerId !== "string") {
      throw Object.assign(new Error("Invalid update tracker request."), { code: "invalid_input" });
    }
    if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) {
      throw Object.assign(new Error("Invalid update tracker request."), { code: "invalid_input" });
    }
    // Match initializeProject's git gate so we never persist credentials for
    // unsuitable folders.
    if (!detectGitRepository(input.projectDir)) {
      throw new Error(
        "This folder is not a git repository. Choose a git-connected project before updating PM.",
      );
    }
    // Hold the context-switch mutex so an agent IPC cannot interleave after the
    // env is rewritten but before the new session is ready (same contract as
    // switchTracker / switchHarness).
    return switchContext(async (projectDir) => {
      if (resolve(projectDir) !== resolve(input.projectDir)) {
        throw new Error("Project directory does not match the active session.");
      }
      await persistTrackerCredentials(projectDir, input.trackerId, input.values);
    });
  });
}
