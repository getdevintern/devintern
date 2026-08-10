/**
 * Sidebar project binding: how a connected checkout maps to a remote.
 *
 * Managed clones live under app userData; "Open existing folder" bindings are
 * unmanaged and are never silently migrated into managed storage.
 */

/** Persisted project ↔ remote binding (settings.json). */
export interface ProjectBinding {
  /** Stable id (uuid fragment) used in managed directory names. */
  id: string;
  /**
   * Canonical GitHub identity (`owner/repo` lowercase) when known.
   * Null for unmanaged folders with no detectable GitHub remote.
   */
  remote: string | null;
  /** Absolute local checkout path. */
  localPath: string;
  /** Preferred branch at Connect time (optional). */
  branch?: string;
  /** Epoch ms of the last successful fetch (open / Update). */
  lastFetch?: number;
  /** True when the app owns the clone under userData/projects. */
  managed: boolean;
}

/** Renderer-facing binding snapshot on {@link import("./ipc-contract.ts").ProjectStatus}. */
export interface ProjectBindingInfo {
  id: string;
  remote: string | null;
  localPath: string;
  branch?: string;
  lastFetch?: number;
  managed: boolean;
}

export function toProjectBindingInfo(binding: ProjectBinding): ProjectBindingInfo {
  return {
    id: binding.id,
    remote: binding.remote,
    localPath: binding.localPath,
    branch: binding.branch,
    lastFetch: binding.lastFetch,
    managed: binding.managed,
  };
}

/**
 * Coerce hand-edited / corrupt `projectBindings` JSON to a list.
 * Non-arrays become undefined so callers can treat as empty.
 */
export function normalizeProjectBindings(raw: unknown): ProjectBinding[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProjectBinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0) continue;
    if (typeof e.localPath !== "string" || e.localPath.length === 0) continue;
    if (typeof e.managed !== "boolean") continue;
    if (e.remote !== null && e.remote !== undefined && typeof e.remote !== "string") continue;
    if (e.branch !== undefined && typeof e.branch !== "string") continue;
    if (e.lastFetch !== undefined && typeof e.lastFetch !== "number") continue;
    out.push({
      id: e.id,
      remote: typeof e.remote === "string" ? e.remote : null,
      localPath: e.localPath,
      branch: typeof e.branch === "string" ? e.branch : undefined,
      lastFetch: typeof e.lastFetch === "number" ? e.lastFetch : undefined,
      managed: e.managed,
    });
  }
  return out;
}
