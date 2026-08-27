/**
 * Generic registry for built-in scheduled-automation presets.
 *
 * A preset is a versioned, data-driven definition that turns an
 * `[[automations]]` entry (which names `preset` instead of carrying a raw
 * `prompt`) into a full run: option validation, prerequisite checks, prompt
 * construction, execution, and side effects. The scheduler
 * ({@link ../automation-acquirer!AutomationAcquirer}) and the config parser
 * stay preset-agnostic — adding a preset never touches scheduler control
 * flow.
 *
 * Definitions declare their supported output modes (`ticket` or
 * `pull_request`), validate their own option keys, and expose an optional
 * `run` function the acquirer invokes in place of the generic
 * prompt-materialization pipeline.
 */

/** Output channel a preset run publishes through. */
export type PresetOutputMode = "ticket" | "pull_request";

/** Resolved per-automation preset configuration after config validation. */
export interface ResolvedPresetConfig {
  /** Registry name, e.g. `docs-drift-guard`. */
  name: string;
  /** Definition version the entry was validated against. */
  version: number;
  /** Selected output mode (preset default when the entry omits it). */
  outputMode: PresetOutputMode;
  /** Preset-specific normalized options (path overrides, baselines, ...). */
  options: Record<string, unknown>;
}

/** Raw per-entry table handed to preset validators during config parsing. */
export interface PresetValidationContext {
  /** The raw `[[automations]]` table (TOML scalar/array values). */
  table: Record<string, unknown>;
  /** Collect a validation error for the entry being parsed. */
  error: (message: string) => void;
}

/** Environment-level context for prerequisite checks at dispatch time. */
export interface PresetPrerequisiteContext {
  /** Repository worktree the run would execute in. */
  cwd: string;
  /** Active `TASK_TRACKER` (defaults to `jira` upstream). */
  trackerType: string;
  /** The entry's resolved preset configuration. */
  resolved: ResolvedPresetConfig;
  error: (message: string) => void;
}

/** Inputs a preset's run function receives from the automation acquirer. */
export interface PresetRunInput {
  automationId: string;
  resolved: ResolvedPresetConfig;
  /** Repository worktree (base worktree in workspace mode). */
  cwd: string;
  /** Repository name for state keying, when known. */
  repoName?: string;
  /** Queue database path for checkpoints and run records. */
  dbPath: string;
  /** Abort signal; cooperative presets poll this between phases. */
  signal?: AbortSignal;
}

/** A built-in preset definition. Registered once at module load. */
export interface PresetDefinition {
  /** Registry key referenced by `preset = "..."` in automations.toml. */
  name: string;
  /** Bumped when option semantics change in a breaking way. */
  version: number;
  /** One-line human summary shown in validation errors and docs. */
  summary: string;
  /** Supported output modes. */
  outputModes: PresetOutputMode[];
  /** Used when the config entry omits `output_mode`. */
  defaultOutputMode: PresetOutputMode;
  /** Validate preset-specific option keys on the raw table. */
  validateOptions?: (context: PresetValidationContext) => void;
  /** Environment-level prerequisites checked before any run work. */
  checkPrerequisites?: (context: PresetPrerequisiteContext) => void;
  /** Execute one scheduled occurrence. Returns whether it completed. */
  run?: (input: PresetRunInput) => Promise<boolean>;
}

const presets = new Map<string, PresetDefinition>();

/** Register (or replace) a preset definition. Built-ins register at import. */
export function registerPreset(definition: PresetDefinition): void {
  presets.set(definition.name, definition);
}

/** Look up a preset definition, or `undefined` for unknown names. */
export function getPreset(name: string): PresetDefinition | undefined {
  return presets.get(name);
}

/** All registered preset definitions, sorted by name for stable output. */
export function listPresets(): PresetDefinition[] {
  return [...presets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Registered preset names (sorted), for actionable validation errors. */
export function listPresetNames(): string[] {
  return listPresets().map((preset) => preset.name);
}

/**
 * Resolve an entry's output mode against its preset definition.
 *
 * @returns The resolved mode, or `null` after pushing an error.
 */
export function resolvePresetOutputMode(
  definition: PresetDefinition,
  table: Record<string, unknown>,
  onError: (message: string) => void,
): PresetOutputMode | null {
  const raw = table.output_mode;
  if (raw === undefined || raw === null) return definition.defaultOutputMode;
  if (typeof raw !== "string" || !raw.trim()) {
    onError("output_mode must be a non-empty string.");
    return null;
  }
  const mode = raw.trim() as PresetOutputMode;
  if (!definition.outputModes.includes(mode)) {
    onError(
      `output_mode "${mode}" is not supported by preset "${definition.name}". ` +
        `Supported modes: ${definition.outputModes.join(", ")}.`,
    );
    return null;
  }
  return mode;
}
