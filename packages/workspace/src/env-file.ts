import { existsSync, readFileSync } from "node:fs";

/**
 * Parse dotenv-style text: `KEY=value` lines, `#` comments, an optional shell
 * `export ` prefix, and optional matching single or double quotes around the
 * value.
 */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (!key || valueParts.length === 0) continue;
    let value = valueParts.join("=").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key.trim()] = value;
  }
  return env;
}

/**
 * Read a dotenv-style file. A missing or unreadable file yields `{}`.
 *
 * @param path - Absolute path of the file
 */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseEnvText(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
