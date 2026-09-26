import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BrowserWindow, clipboard, dialog } from "electron";
import { MAX_ATTACHMENTS, attachmentExtensionError } from "@getdevintern/pm/attachments";
import { IPC_CHANNELS } from "../../shared/ipc-contract.ts";
import { readProjectEnv } from "../project-env.ts";
import { listRecentProjectDirs } from "../recent-projects.ts";
import { readSettings } from "../settings.ts";
import { validateRequiredTools } from "../validate-tools.ts";
import { handle } from "./register.ts";

/** File-picker, clipboard, tools, and recent-project IPC handlers. */
export function registerDialogIpcHandlers(): void {
  handle(IPC_CHANNELS.chooseProjectDir, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    // Electron 43+ opens Downloads when defaultPath is omitted; seed from
    // lastProjectDir (updated on successful open in getProjectStatus / initializeProject).
    const settings = await readSettings();
    const result = await dialog.showOpenDialog(window!, {
      title: "Open existing project folder",
      defaultPath: settings.lastProjectDir ?? undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  handle(IPC_CHANNELS.chooseAttachmentFiles, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window!, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Supported attachments",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "webp",
            "gif",
            "txt",
            "md",
            "markdown",
            "csv",
            "tsv",
            "json",
            "yaml",
            "yml",
            "xml",
            "html",
            "log",
            "pdf",
            "ipynb",
          ],
        },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        {
          name: "Documents",
          extensions: ["txt", "md", "markdown", "csv", "json", "yaml", "yml", "pdf"],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    const refs = [];
    for (const filePath of result.filePaths.slice(0, MAX_ATTACHMENTS)) {
      const name = basename(filePath);
      const extError = attachmentExtensionError(name);
      if (extError) {
        throw new Error(`${name}: ${extError}`);
      }
      refs.push({ path: filePath, name });
    }
    return refs;
  });

  handle(IPC_CHANNELS.saveClipboardImage, async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return null;
    }
    const dir = mkdtempSync(join(tmpdir(), "devpm-clipboard-"));
    const name = `screenshot-${Date.now()}.png`;
    const filePath = join(dir, name);
    writeFileSync(filePath, image.toPNG());
    return { path: filePath, name };
  });

  handle(IPC_CHANNELS.getLastProjectDir, async () => {
    const settings = await readSettings();
    return settings.lastProjectDir ?? null;
  });

  handle(IPC_CHANNELS.validateRequiredTools, async () => {
    const settings = await readSettings();
    let agentEnv: Record<string, string> = {};
    if (settings.lastProjectDir) {
      try {
        const { env } = await readProjectEnv(settings.lastProjectDir);
        agentEnv = Object.fromEntries(
          Object.entries(env).filter(
            ([key]) =>
              key === "AGENT_HARNESS" || key === "AGENT_CLI_PATH" || key.endsWith("_CLI_PATH"),
          ),
        );
      } catch {
        // A stale/unreadable remembered project must not hide process-level tools.
      }
    }
    return validateRequiredTools({ envOverrides: agentEnv });
  });

  handle(IPC_CHANNELS.getRecentProjectDirs, async () => {
    return listRecentProjectDirs();
  });
}
