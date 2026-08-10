#!/usr/bin/env bun
/**
 * Compile with electron-vite, then package with electron-builder.
 * Applies gated signing env (unsigned by default).
 *
 * Usage:
 *   bun run scripts/package.ts            # current platform
 *   bun run scripts/package.ts --linux
 *   bun run scripts/package.ts --mac
 *   bun run scripts/package.ts --dir       # unpackaged dir only (faster smoke)
 */

import { spawnSync } from "node:child_process";
import { resolveSigningEnv } from "./signing-env.ts";

const args = process.argv.slice(2);
const builderArgs = args.length > 0 ? args : [];

const signing = resolveSigningEnv();
for (const note of signing.notes) {
  console.log(`[package] ${note}`);
}

const env: NodeJS.ProcessEnv = { ...process.env };
for (const [key, value] of Object.entries(signing.env)) {
  if (value === undefined) {
    delete env[key];
  } else {
    env[key] = value;
  }
}

function run(command: string, commandArgs: string[]): void {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env,
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("[package] electron-vite build…");
run("bun", ["run", "build"]);

console.log(`[package] electron-builder ${builderArgs.join(" ") || "(current platform)"}…`);
run("bun", [
  "x",
  "electron-builder",
  "--config",
  "electron-builder.yml",
  "--publish",
  "never",
  ...builderArgs,
]);
