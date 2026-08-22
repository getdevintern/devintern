/**
 * Quick Capture pure helpers shared by main, preload, and renderer.
 *
 * Quick Capture registers an OS-level global shortcut that focuses (or
 * launches) the app and opens a fresh ticket workspace, optionally prefilled
 * from the clipboard. This module holds the platform-independent logic:
 * accelerator defaults/validation, clipboard-text classification into a
 * composer source tab, and keyboard-event → Electron-accelerator mapping for
 * the in-app recorder.
 */

import type { SourceType } from "./ipc-contract.ts";

/** Sensible default binding, valid on macOS (⌘) and Windows/Linux (Ctrl). */
export const DEFAULT_QUICK_CAPTURE_ACCELERATOR = "CommandOrControl+Shift+Space";

/** Human-readable default for docs/UI copy. */
export const QUICK_CAPTURE_DEFAULT_LABEL = "Cmd/Ctrl+Shift+Space";

/** Above this size a capture is treated as not useful (protects the composer + agent prompt). */
export const MAX_CAPTURE_CHARS = 50_000;

/** Shorter than this, text is treated as accidental clipboard noise. */
const MIN_USEFUL_CAPTURE_CHARS = 3;

/** Config persisted in settings.json. `shortcut === null` means platform default. */
export interface QuickCaptureConfig {
  enabled: boolean;
  shortcut: string | null;
}

/** What the renderer receives on each invocation. */
export interface QuickCaptureEvent {
  /** Sanitized clipboard text, or null when empty/not useful. */
  text: string | null;
  /** Composer tab inferred from the captured content. */
  sourceType: SourceType;
}

/** Registration snapshot surfaced to Settings. */
export interface QuickCaptureStatus {
  enabled: boolean;
  /** Effective accelerator (the resolved default when no custom one is set). */
  shortcut: string;
  /** True while the OS-level registration is held. */
  registered: boolean;
  /** Present when registration failed (conflict with another app or invalid). */
  error?: string;
}

/** True when the string looks like a Figma file/design URL. */
export function looksLikeFigmaUrl(text: string): boolean {
  return /https:\/\/(?:[a-z0-9-]+\.)*figma\.com\//i.test(text);
}

const STACK_TRACE_PATTERNS: RegExp[] = [
  /^\s*at\s+.+\(.+:\d+(?::\d+)?\)/m, // JS/V8 frame
  /^\s*at\s+\S+:\d+(?::\d+)?$/m, // Node plain frame
  /\b(Typed|Error|Exception)\b.*(?:\n\s*at\s|\n\s+\w+)/, // error header followed by frames
  /^[A-Za-z_$][\w$]*(?:Error|Exception)\b/m, // TypeError / NullPointerException …
  /^Traceback \(most recent call last\)/m, // Python
  /\bat\s+[\w$.]+\([\w./\\]+:\d+\)/, // Java-ish frame
];

/** Heuristic: does this look like an error log or stack trace? */
export function looksLikeStackTrace(text: string): boolean {
  return STACK_TRACE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Trim + size-cap captured clipboard text; returns null when empty/oversized-only noise. */
export function sanitizeCapturedText(text: string | null | undefined): {
  text: string | null;
  sourceType: SourceType;
} {
  if (typeof text !== "string") return { text: null, sourceType: "prompt" };
  const trimmed = text.trim();
  if (
    trimmed.length < MIN_USEFUL_CAPTURE_CHARS ||
    trimmed.length > MAX_CAPTURE_CHARS ||
    /^[\s\p{C}]+$/u.test(trimmed)
  ) {
    return { text: null, sourceType: "prompt" };
  }
  const sourceType: SourceType = looksLikeFigmaUrl(trimmed)
    ? "figma"
    : looksLikeStackTrace(trimmed)
      ? "log"
      : "prompt";
  return { text: trimmed.slice(0, MAX_CAPTURE_CHARS), sourceType };
}

/**
 * Resolve the effective accelerator for a stored config.
 * Falls back to the platform default when unset/blank.
 */
export function resolveQuickCaptureAccelerator(shortcut: string | null | undefined): string {
  const trimmed = typeof shortcut === "string" ? shortcut.trim() : "";
  if (trimmed.length > 0) return trimmed;
  return DEFAULT_QUICK_CAPTURE_ACCELERATOR;
}

/** Basic structural check mirroring Electron's accelerator grammar (modifiers + key). */
export function isValidAcceleratorShape(accelerator: string): boolean {
  const trimmed = accelerator.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  if (/[\n\t]/.test(trimmed)) return false;
  const parts = trimmed.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) return false;
  const modifiers = new Set([
    "Command",
    "Cmd",
    "Control",
    "Ctrl",
    "CommandOrControl",
    "CmdOrCtrl",
    "Alt",
    "Option",
    "AltGr",
    "Shift",
    "Super",
  ]);
  const modifierCount = parts.filter((part) => modifiers.has(part)).length;
  const [key] = parts.slice(-1);
  const keyPattern =
    /^(?:[0-9A-Z]|F([1-9]|1\d|2[0-4])|Space|Tab|Capslock|Numlock|Scrolllock|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause|PrintScreen|Num(?:[0-9]|Dec|Add|Sub|Mult|Div)|[;=/[\]\\'`,.-])$/;
  if (!key || !keyPattern.test(key)) return false;
  // A usable global shortcut needs at least one non-plain-key modifier, or is a lone F-key.
  return modifierCount > 0 || /^F([1-9]|1\d|2[0-4])$/.test(key);
}

const KEY_LABEL_TO_ACCELERATOR = new Map<string, string>([
  [" ", "Space"],
  ["spacebar", "Space"],
  ["escape", "Escape"],
  ["esc", "Escape"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["enter", "Return"],
  ["arrowup", "Up"],
  ["arrowdown", "Down"],
  ["arrowleft", "Left"],
  ["arrowright", "Right"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["capslock", "Capslock"],
]);

const PUNCTUATION_TO_ACCELERATOR = new Map<string, string>([
  [";", ";"],
  ["=", "="],
  [",", ","],
  ["-", "-"],
  [".", "."],
  ["/", "/"],
  ["[", "["],
  ["]", "]"],
  ["'", "'"],
  ["\\", "\\"],
  ["`", "`"],
]);

export interface RecorderKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Map a DOM KeyboardEvent-like object to an Electron accelerator string.
 * Returns null for unrecordable input (bare letters without modifiers,
 * modifier-only presses). The caller decides whether Escape cancels.
 */
export function acceleratorFromKeyboardEvent(event: RecorderKeyEvent): string | null {
  const key = event.key ?? "";
  if (key === "Escape") return null;
  const lower = key.toLowerCase();

  let mapped: string | undefined;
  if (/^[a-z]$/i.test(key)) {
    mapped = key.toUpperCase();
  } else if (/^[0-9]$/.test(key)) {
    mapped = key;
  } else if (/^F([1-9]|1\d|2[0-4])$/i.test(key)) {
    mapped = key.toUpperCase();
  } else {
    mapped = KEY_LABEL_TO_ACCELERATOR.get(lower) ?? PUNCTUATION_TO_ACCELERATOR.get(key);
  }
  if (!mapped) return null;

  const parts: string[] = [];
  // On macOS Command is the primary modifier; elsewhere Ctrl.
  if (event.metaKey) parts.push("Command");
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(mapped);

  const hasModifier = event.metaKey || event.ctrlKey || event.altKey;
  const isFunctionKey = /^F([1-9]|1\d|2[0-4])$/.test(mapped);
  if (!hasModifier && !isFunctionKey) return null;
  return parts.join("+");
}

/** Copy shown when a shortcut could not be registered (AC: clear message + how to fix). */
export function quickCaptureConflictMessage(accelerator: string): string {
  return `${accelerator} could not be registered — another app may already be using it. Record a different combination in Settings → Quick Capture.`;
}

/** Human-friendly accelerator label ("Cmd/Ctrl", "⌘-style" not assumed). */
export function prettyAccelerator(accelerator: string, applePlatform: boolean): string {
  const primary = applePlatform ? "Cmd" : "Ctrl";
  return accelerator
    .split("+")
    .map((part) => {
      switch (part.trim()) {
        case "CommandOrControl":
        case "CmdOrCtrl":
          return primary;
        case "Command":
        case "Cmd":
          return "Cmd";
        case "Control":
        case "Ctrl":
          return "Ctrl";
        case "Option":
          return "Option";
        default:
          return part.trim();
      }
    })
    .join("+");
}
