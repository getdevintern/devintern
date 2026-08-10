/** Last path segment of a project directory (POSIX or Windows separators). */
export function projectDirBasename(projectDir: string): string {
  const parts = projectDir.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? projectDir;
}

/**
 * Compact label for a project directory: basename by default, or
 * `parent/basename` when another path in `among` shares the same basename
 * (e.g. two `frontend` checkouts).
 */
export function formatProjectDirLabel(projectDir: string, among: readonly string[] = []): string {
  const parts = projectDir.split(/[/\\]/).filter(Boolean);
  const base = parts.at(-1) ?? projectDir;
  if (among.length === 0) return base;

  const collisions = among.filter((dir) => projectDirBasename(dir) === base);
  if (collisions.length <= 1) return base;

  const parent = parts.at(-2);
  return parent ? `${parent}/${base}` : base;
}
