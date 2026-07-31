/**
 * Terminal encoding helpers for portable CLI output (Node, Bun, Electron).
 *
 * Mojibake like "â¢" instead of "•" means UTF-8 bytes were interpreted as Latin-1.
 * We configure UTF-8 where the OS allows it and fall back to ASCII UI symbols otherwise.
 */

import { execSync } from "node:child_process";

let configured = false;

/**
 * Locale verdict captured before configureTerminalEncoding mutates the env,
 * so uiSymbols reflects the real environment rather than our own override.
 */
let initialUtf8Locale: boolean | null = null;

/** Test-only: forget the cached locale verdict and configuration flag. */
export function resetTerminalDetectionForTests(): void {
  initialUtf8Locale = null;
  configured = false;
}

/**
 * Return true when the process locale indicates UTF-8.
 */
export function hasUtf8Locale(): boolean {
  const lang = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "";
  return /utf-?8/i.test(lang);
}

/**
 * Heuristic for modern terminals that render Unicode even when LANG is unset.
 */
export function isUnicodeCapableTerminal(): boolean {
  const { TERM, TERM_PROGRAM, WT_SESSION, TERMINAL_EMULATOR } = process.env;

  if (WT_SESSION) return true;
  if (TERM_PROGRAM === "vscode" || TERM_PROGRAM === "cursor") return true;
  if (TERMINAL_EMULATOR === "JetBrains-JediTerm") return true;
  if (process.platform === "darwin") return true;

  if (process.platform === "win32") {
    return (
      TERM === "xterm-256color" ||
      TERM === "alacritty" ||
      TERM === "rxvt-unicode" ||
      TERM === "rxvt-unicode-256color"
    );
  }

  return TERM !== "linux";
}

/**
 * Configure stdout/stderr for UTF-8 where possible.
 *
 * Call once at process startup, before any Ink UI or other TTY output.
 * On Windows this switches the console code page to 65001. On Unix it sets
 * UTF-8 locale env vars when none are present (helps child processes; some
 * terminal hosts also key off LANG).
 */
export function configureTerminalEncoding(): void {
  initialUtf8Locale ??= hasUtf8Locale();
  if (!initialUtf8Locale) {
    // A bare "UTF-8" is not a valid locale; pick one child processes can
    // actually setlocale() with.
    const locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
    process.env.LC_CTYPE = locale;
    process.env.LANG = locale;
  }

  if (configured) return;
  configured = true;

  if (process.platform === "win32") {
    try {
      execSync("chcp 65001 >nul 2>&1", { stdio: "ignore", windowsHide: true });
    } catch {
      // Non-fatal: continue with stream encoding below.
    }
  }

  for (const stream of [process.stdout, process.stderr]) {
    if (!stream.isTTY) continue;
    if ("setDefaultEncoding" in stream && typeof stream.setDefaultEncoding === "function") {
      stream.setDefaultEncoding("utf8");
    } else if (typeof stream.setEncoding === "function") {
      stream.setEncoding("utf8");
    }
  }
}

/**
 * UI symbols for Ink chrome. Uses Unicode when the environment likely supports it.
 *
 * Decides from the locale as it was before configureTerminalEncoding's env
 * override, so forcing UTF-8 for child processes cannot fake terminal support.
 */
export function uiSymbols(): {
  sep: string;
  scrollArrows: string;
  listBullet: string;
} {
  initialUtf8Locale ??= hasUtf8Locale();
  const unicode = initialUtf8Locale || isUnicodeCapableTerminal();
  return {
    sep: unicode ? " • " : " | ",
    scrollArrows: unicode ? "↑↓" : "Up/Down",
    listBullet: unicode ? "•" : "-",
  };
}
