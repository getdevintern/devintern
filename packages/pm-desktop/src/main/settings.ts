/**
 * Tiny JSON settings store at `<userData>/settings.json`.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";

interface Settings {
  lastProjectDir?: string;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

export async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const current = await readSettings();
  const next = { ...current, ...patch };
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
}
