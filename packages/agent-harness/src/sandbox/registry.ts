/**
 * Sandbox provider registry. New providers can be registered at runtime
 * or by editing this file. Mirrors the harness registry in `../registry.ts`.
 */

import type { SandboxProvider } from "./types.js";
import { DockerSandboxProvider } from "./providers/docker.js";
import { NativeSandboxProvider } from "./providers/native.js";
import { NonoSandboxProvider } from "./providers/nono.js";
import { SmolvmSandboxProvider } from "./providers/smolvm.js";
import { SrtSandboxProvider } from "./providers/srt.js";

const registry = new Map<string, SandboxProvider>();

/**
 * Register a provider for lookup by {@link getSandboxProvider}.
 *
 * @param provider - Provider instance; keyed by {@link SandboxProvider.name}.
 */
export function registerSandboxProvider(provider: SandboxProvider): void {
  registry.set(provider.name, provider);
}

/**
 * Look up a registered provider by its machine-readable name.
 *
 * @param name - Provider identifier (e.g. `"nono"`).
 * @returns The provider, or `undefined` if not registered.
 */
export function getSandboxProvider(name: string): SandboxProvider | undefined {
  return registry.get(name);
}

/**
 * Return every provider currently registered.
 *
 * @returns A snapshot of all registered provider instances.
 */
export function listSandboxProviders(): SandboxProvider[] {
  return Array.from(registry.values());
}

// Register built-in providers -------------------------------------------------
registerSandboxProvider(new NativeSandboxProvider());
registerSandboxProvider(new NonoSandboxProvider());
registerSandboxProvider(new SrtSandboxProvider());
registerSandboxProvider(new DockerSandboxProvider());
registerSandboxProvider(new SmolvmSandboxProvider());
