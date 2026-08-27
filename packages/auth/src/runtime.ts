import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_REMOTE_AUTH_CALLBACK_PORT } from "./auth-callback";

/**
 * Read a text file, or return `null` when it does not exist.
 *
 * @param path - Absolute file path.
 * @returns File contents, or `null` when missing.
 */
export async function readTextFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write a text file, creating parent directories as needed.
 *
 * @param path - Absolute file path.
 * @param content - File contents to write.
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * Delete a file if it exists. No-op when missing.
 *
 * @param path - Absolute file path.
 */
export async function removeFileIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * True when this process looks like an SSH/mosh (or similar) remote shell —
 * no local GUI browser will receive `open` / `xdg-open`.
 */
export function isRemoteCliSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.MOSH || env.LC_MOSH_CONNECTION,
  );
}

/**
 * Resolve the localhost port for the OAuth/magic-link callback server.
 *
 * Prefer `DEVINTERN_AUTH_CALLBACK_PORT` when set; otherwise use a stable port
 * for remote shells (SSH LocalForward), and an ephemeral port locally.
 */
export function resolveAuthCallbackPort(
  env: NodeJS.ProcessEnv = process.env,
  remote = isRemoteCliSession(env),
): number | undefined {
  const raw = env.DEVINTERN_AUTH_CALLBACK_PORT?.trim();
  if (raw) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `DEVINTERN_AUTH_CALLBACK_PORT must be an integer 1–65535 (got ${JSON.stringify(raw)}).`,
      );
    }
    return port;
  }
  if (remote) {
    return DEFAULT_REMOTE_AUTH_CALLBACK_PORT;
  }
  return undefined;
}

/**
 * Open a URL in the system default browser (macOS, Windows, or Linux).
 *
 * Waits for the launcher to exit so failures surface. Callers should still
 * print the URL for manual open when this throws or the session is remote.
 */
export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const [command, ...args] =
    platform === "darwin"
      ? ["open", "-u", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command!, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    proc.once("error", reject);
    proc.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(
        new Error(
          detail
            ? `Failed to open browser (exit ${code}): ${detail}`
            : `Failed to open browser (exit ${code ?? "unknown"}).`,
        ),
      );
    });
  });
}
