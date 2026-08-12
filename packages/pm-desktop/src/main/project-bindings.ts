/**
 * Persist and look up {@link ProjectBinding} entries in settings.json.
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { normalizeProjectBindings } from "../shared/project-binding.ts";
import type { ProjectBinding } from "../shared/project-binding.ts";
import { readSettings, updateSettings } from "./settings.ts";

function bindingsFromSettings(settings: { projectBindings?: unknown }): ProjectBinding[] {
  return normalizeProjectBindings(settings.projectBindings) ?? [];
}

/** All stored bindings (may include stale paths — callers filter). */
export async function listProjectBindings(): Promise<ProjectBinding[]> {
  const settings = await readSettings();
  return bindingsFromSettings(settings);
}

/** Find a managed binding for the canonical remote slug. */
export async function findManagedBindingByRemote(
  remoteSlug: string,
): Promise<ProjectBinding | null> {
  const slug = remoteSlug.toLowerCase();
  const bindings = await listProjectBindings();
  return bindings.find((b) => b.managed && b.remote?.toLowerCase() === slug) ?? null;
}

/** Find a binding by absolute local path. */
export async function findBindingByLocalPath(localPath: string): Promise<ProjectBinding | null> {
  const resolved = resolve(localPath);
  const bindings = await listProjectBindings();
  return bindings.find((b) => resolve(b.localPath) === resolved) ?? null;
}

/**
 * Insert or replace a binding by id (and drop other managed bindings for the
 * same remote so uniqueness holds).
 */
export async function upsertProjectBinding(binding: ProjectBinding): Promise<ProjectBinding> {
  const resolved: ProjectBinding = {
    ...binding,
    localPath: resolve(binding.localPath),
    remote: binding.remote ? binding.remote.toLowerCase() : null,
  };
  await updateSettings((settings) => {
    const current = bindingsFromSettings(settings);
    const next: ProjectBinding[] = [];
    for (const b of current) {
      if (b.id === resolved.id) continue;
      // One managed clone per remote.
      if (
        resolved.managed &&
        b.managed &&
        resolved.remote &&
        b.remote?.toLowerCase() === resolved.remote
      ) {
        continue;
      }
      // One binding per local path.
      if (resolve(b.localPath) === resolved.localPath) continue;
      next.push(b);
    }
    next.unshift(resolved);
    return { ...settings, projectBindings: next };
  });
  return resolved;
}

/** Remember a binding and bump it to the front (Connect / open). */
export async function rememberProjectBinding(binding: ProjectBinding): Promise<ProjectBinding> {
  return upsertProjectBinding(binding);
}

/** Update lastFetch for the binding at localPath (no-op when unknown). */
export async function touchProjectBindingLastFetch(localPath: string, at: number): Promise<void> {
  const resolved = resolve(localPath);
  await updateSettings((settings) => {
    const current = bindingsFromSettings(settings);
    let changed = false;
    const next = current.map((b) => {
      if (resolve(b.localPath) !== resolved) return b;
      changed = true;
      return { ...b, lastFetch: at };
    });
    if (!changed) return settings;
    return { ...settings, projectBindings: next };
  });
}

/** Remove a binding by id. Does not delete files. */
export async function removeProjectBinding(id: string): Promise<ProjectBinding | null> {
  let removed: ProjectBinding | null = null;
  await updateSettings((settings) => {
    const current = bindingsFromSettings(settings);
    const next: ProjectBinding[] = [];
    for (const b of current) {
      if (b.id === id) {
        removed = b;
        continue;
      }
      next.push(b);
    }
    return { ...settings, projectBindings: next };
  });
  return removed;
}

/**
 * Ensure an unmanaged binding exists for an "Open existing folder" path.
 * Never sets managed:true and never migrates into userData/projects.
 */
export async function ensureUnmanagedBinding(options: {
  localPath: string;
  remote?: string | null;
  branch?: string;
}): Promise<ProjectBinding> {
  const existing = await findBindingByLocalPath(options.localPath);
  if (existing) {
    return upsertProjectBinding({
      ...existing,
      // Preserve managed flag — never upgrade folder opens to managed.
      managed: existing.managed,
      remote:
        options.remote !== undefined
          ? options.remote
            ? options.remote.toLowerCase()
            : null
          : existing.remote,
      branch: options.branch ?? existing.branch,
    });
  }
  const id = randomBindingId();
  return upsertProjectBinding({
    id,
    remote: options.remote ? options.remote.toLowerCase() : null,
    localPath: options.localPath,
    branch: options.branch,
    managed: false,
  });
}

function randomBindingId(): string {
  return randomBytes(4).toString("hex");
}
