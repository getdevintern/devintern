/**
 * Regression coverage for `--env-file` precedence: an explicit file must be
 * the only `.env` source, so keys it omits are never filled from the implicit
 * project `.env` (which a cloned repository controls).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { findEnvFileArg } from "../src/lib/cli/bootstrap";

describe("findEnvFileArg", () => {
  test("reads both supported flag forms", () => {
    expect(findEnvFileArg(["node", "devintern", "TASK-1", "--env-file", "/tmp/a.env"])).toBe(
      "/tmp/a.env",
    );
    expect(findEnvFileArg(["node", "devintern", "--env-file=/tmp/b.env", "TASK-1"])).toBe(
      "/tmp/b.env",
    );
  });

  test("returns undefined when the flag is absent or has no value", () => {
    expect(findEnvFileArg(["node", "devintern", "TASK-1"])).toBeUndefined();
    expect(findEnvFileArg(["node", "devintern", "--env-file"])).toBeUndefined();
    expect(findEnvFileArg(["node", "devintern", "--env-file", "--verbose"])).toBeUndefined();
    expect(
      findEnvFileArg(["node", "devintern", "--", "--env-file", "/tmp/positional.env"]),
    ).toBeUndefined();
  });
});

describe("explicit --env-file is the sole .env source", () => {
  let root: string;
  const bootstrapPath = join(__dirname, "..", "src", "lib", "cli", "bootstrap.ts");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bootstrap-env-file-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Load env in a clean subprocess so process-wide state cannot leak. */
  function loadWith(argv: string[]): {
    path: string | null;
    project: string | null;
    custom: string | null;
  } {
    const script = [
      `import { findEnvFileArg, loadEnvironment } from ${JSON.stringify(bootstrapPath)};`,
      `const argv = ${JSON.stringify(argv)};`,
      "const path = loadEnvironment(findEnvFileArg(argv));",
      "console.log(JSON.stringify({ path, project: process.env.E2E_PROJECT_ONLY ?? null, custom: process.env.E2E_CUSTOM_ONLY ?? null }));",
    ].join("\n");
    const env: NodeJS.ProcessEnv = { ...process.env, SENTRY_DISABLED: "1" };
    delete env.E2E_PROJECT_ONLY;
    delete env.E2E_CUSTOM_ONLY;
    const result = spawnSync("bun", ["-e", script], { cwd: root, env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`bootstrap probe failed: ${result.stderr || result.stdout}`);
    }
    const jsonLine = result.stdout
      .split("\n")
      .reverse()
      .find((line) => line.trim().startsWith("{"));
    if (!jsonLine) throw new Error(`bootstrap probe produced no JSON: ${result.stdout}`);
    return JSON.parse(jsonLine.trim());
  }

  test("keys absent from the custom file are not taken from the project .env", () => {
    mkdirSync(join(root, ".devintern-code"), { recursive: true });
    writeFileSync(
      join(root, ".devintern-code", ".env"),
      "E2E_PROJECT_ONLY=from-project\nE2E_SHARED=project-value\n",
    );
    const customPath = join(root, "custom.env");
    writeFileSync(customPath, "E2E_CUSTOM_ONLY=from-custom\nE2E_SHARED=custom-value\n");

    const loaded = loadWith(["node", "devintern", "TASK-1", "--env-file", customPath]);

    expect(loaded.path).toBe(customPath);
    expect(loaded.project).toBeNull();
    expect(loaded.custom).toBe("from-custom");
  });

  test("without --env-file the project .env is still loaded", () => {
    mkdirSync(join(root, ".devintern-code"), { recursive: true });
    writeFileSync(join(root, ".devintern-code", ".env"), "E2E_PROJECT_ONLY=from-project\n");

    const loaded = loadWith(["node", "devintern", "TASK-1"]);

    expect(loaded.path).toBe(join(root, ".devintern-code", ".env"));
    expect(loaded.project).toBe("from-project");
  });
});
