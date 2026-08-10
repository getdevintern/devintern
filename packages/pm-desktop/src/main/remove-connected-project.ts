/**
 * Remove a connected project binding (and optionally its managed checkout).
 * Keeps IPC thin and testable without importing Electron.
 */

import { resolve } from "node:path";
import { deleteManagedCloneDir } from "./managed-clone.ts";
import { findBindingByLocalPath, removeProjectBinding } from "./project-bindings.ts";
import { clearSessionIfProjectDir, withContextSwitchMutex } from "./session.ts";
import { updateSettings } from "./settings.ts";

export async function removeConnectedProject(options: {
  localPath: string;
  deleteFiles: boolean;
}): Promise<void> {
  const resolved = resolve(options.localPath);

  await withContextSwitchMutex(async () => {
    const binding = await findBindingByLocalPath(resolved);
    if (binding) {
      if (options.deleteFiles && !binding.managed) {
        throw new Error(
          "Only app-managed clones can be deleted from disk. Remove the folder yourself if you opened an existing directory.",
        );
      }
    } else if (options.deleteFiles) {
      throw new Error("No connected project found for that path.");
    }

    // Null session before any rm so in-flight IPC cannot keep targeting this path.
    clearSessionIfProjectDir(resolved);

    if (binding) {
      if (options.deleteFiles) {
        await deleteManagedCloneDir(binding.localPath);
      }
      await removeProjectBinding(binding.id);
    }

    // Drop from recents / lastProjectDir when it pointed here.
    await updateSettings((settings) => {
      const recent = (settings.recentProjectDirs ?? []).filter((d) => resolve(d) !== resolved);
      const last =
        settings.lastProjectDir && resolve(settings.lastProjectDir) === resolved
          ? recent[0]
          : settings.lastProjectDir;
      return { ...settings, recentProjectDirs: recent, lastProjectDir: last };
    });
  });
}
