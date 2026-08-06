/**
 * Upsert KEY=value lines in a `.env` file body.
 *
 * Existing assignments (including commented `# KEY=…` lines) are replaced
 * in place. Keys not found are appended at the end.
 */

/**
 * @param content - Current `.env` file contents
 * @param vars - Key/value pairs to write (empty string clears to `KEY=`)
 * @returns Updated file contents
 */
export function upsertEnvVars(content: string, vars: Record<string, string>): string {
  const lines = content.length > 0 ? content.split("\n") : [];
  const pending = new Map(Object.entries(vars));

  const updated = lines.map((line) => {
    const match = line.match(/^\s*#?\s*([A-Z0-9_]+)=/);
    const key = match?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  if (pending.size > 0) {
    if (updated.length > 0 && updated.at(-1)?.trim() !== "") {
      updated.push("");
    }
    for (const [key, value] of pending) {
      updated.push(`${key}=${value}`);
    }
    if (updated.at(-1)?.trim() !== "") {
      updated.push("");
    }
  }

  return updated.join("\n");
}
