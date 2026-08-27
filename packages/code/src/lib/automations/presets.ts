/**
 * Built-in automation presets.
 *
 * Importing this module registers every built-in preset in the generic
 * registry ({@link ./preset-registry}). The config parser and the automation
 * acquirer import from here; adding a preset means adding a definition
 * module and one registration line — no scheduler changes.
 */

import { registerDocsDriftGuard } from "./docs-drift-guard/definition";

export * from "./preset-registry";
export {
  registerDocsDriftGuard,
  docsDriftGuardDefinition,
  PRESET_VERSION,
} from "./docs-drift-guard/definition";

let registered = false;

/** Register all built-in presets exactly once. */
export function registerBuiltInPresets(): void {
  if (registered) return;
  registered = true;
  registerDocsDriftGuard();
}

// Register on import so `preset = "docs-drift-guard"` validates everywhere.
registerBuiltInPresets();
