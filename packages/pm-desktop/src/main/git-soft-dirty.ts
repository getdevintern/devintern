/**
 * Classify a git working tree as clean, PM soft-dirty, or hard-dirty.
 *
 * Soft-dirty is the expected leftover from `pm init` / Connect: an appended
 * repo-root `.gitignore`. Paths under `.devintern-pm/` (secrets, markdown
 * tasks, etc.) and ignored files (`!!`) do not count as dirtiness. Soft-dirty
 * must not block fetch/ff-only update and must not surface as "Local edits";
 * hard-dirty (anything else) does.
 */

/** Working-tree classification used for messaging and pull gating. */
export type WorkingTreeDirtiness = "clean" | "soft-dirty" | "hard-dirty";

/** One parsed `git status --porcelain` / `--ignored` entry. */
export interface PorcelainEntry {
  /** Two-character XY status (e.g. ` M`, `??`, `!!`). */
  xy: string;
  /** Path relative to the git root (unquoted). */
  path: string;
}

/**
 * Parse a single porcelain v1 line into XY + path.
 * Handles rename (`R  old -> new`) and quoted paths with basic escapes.
 */
export function parsePorcelainLine(line: string): PorcelainEntry | null {
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  let rest = line.slice(3);
  // Rename / copy: `R  old -> new` — the destination is what remains dirty.
  const arrow = rest.indexOf(" -> ");
  if (arrow !== -1 && (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C")) {
    rest = rest.slice(arrow + 4);
  }
  const path = unquotePorcelainPath(rest);
  if (!path) return null;
  return { xy, path };
}

function unquotePorcelainPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  // Git quotes with C-style escapes when needed (including octal \NNN).
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      out += "\\";
      break;
    }
    if (next >= "0" && next <= "7") {
      let oct = next;
      let j = i + 2;
      while (j < inner.length && j < i + 4) {
        const digit = inner[j]!;
        if (digit < "0" || digit > "7") break;
        oct += digit;
        j++;
      }
      out += String.fromCharCode(parseInt(oct, 8));
      i = j - 1;
      continue;
    }
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "\\":
      case '"':
        out += next;
        break;
      default:
        out += next;
    }
    i++;
  }
  return out;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * True when this path is the repo-root `.gitignore` PM may have appended.
 * Nested package `.gitignore` files are not soft-dirty — intentional edits
 * there must block Update (hard-dirty).
 */
export function isPmGitignorePath(path: string): boolean {
  return normalizeRepoPath(path) === ".gitignore";
}

/**
 * True when this path is under the PM config dir (secrets, markdown tasks, …).
 * These are expected local leftovers and must not gate Get updates.
 */
export function isPmLocalPath(path: string): boolean {
  const normalized = normalizeRepoPath(path).replace(/\/+$/, "");
  return normalized === ".devintern-pm" || normalized.startsWith(".devintern-pm/");
}

/** Soft-dirty entry: repo-root `.gitignore` change only. */
export function isSoftDirtyEntry(entry: PorcelainEntry): boolean {
  return isPmGitignorePath(entry.path);
}

/**
 * Classify porcelain lines (optionally including `--ignored` `!!` entries).
 *
 * - No entries → clean
 * - Only soft-dirty entries → soft-dirty
 * - Ignored paths (`!!`) and `.devintern-pm/**` are skipped
 * - Unparseable non-empty lines → hard-dirty (fail closed)
 * - Any other entry → hard-dirty
 */
export function classifyPmWorkingTree(lines: readonly string[]): WorkingTreeDirtiness {
  let sawSoft = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const entry = parsePorcelainLine(trimmed);
    // Fail closed: a hard-dirty path that fails to parse must not allow merge.
    if (!entry) return "hard-dirty";
    // Ignored files and PM local state never gate pull or soft-dirty UI.
    if (entry.xy === "!!" || isPmLocalPath(entry.path)) {
      continue;
    }
    if (isSoftDirtyEntry(entry)) {
      sawSoft = true;
      continue;
    }
    return "hard-dirty";
  }
  return sawSoft ? "soft-dirty" : "clean";
}
