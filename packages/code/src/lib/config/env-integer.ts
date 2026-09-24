export interface EnvIntegerOptions {
  /** Smallest accepted value (default: 0). */
  min?: number;
  /** Largest accepted value (default: Number.MAX_SAFE_INTEGER). */
  max?: number;
}

/**
 * Read a finite, safe integer from the environment, falling back on invalid input.
 *
 * @param name - Environment variable name
 * @param defaultValue - Value used when unset, malformed, or outside the configured range
 * @param options - Inclusive minimum and maximum accepted values
 */
export function parseEnvInteger(
  name: string,
  defaultValue: number,
  options: EnvIntegerOptions = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || !/^[+-]?\d+$/.test(raw.trim())) return defaultValue;

  const value = Number(raw);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : defaultValue;
}
