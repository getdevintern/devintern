import type { UtilsSurface } from "./types";

/**
 * Shared `Utils` namespace. Domain modules in this directory register their
 * functions onto this object, so `Utils.method()` call sites keep working and
 * test monkeypatches (`Utils.installDependencies = ...`) stay observable.
 */
export const Utils = {} as UtilsSurface;
