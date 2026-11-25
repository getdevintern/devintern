import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { acquireRunLocks } from "../src/lib/cli/run-locks";
import { checkoutLockFileName, checkoutLocksDir } from "../src/lib/task/ticket-lock";

describe("acquireRunLocks outside a registered workspace repo", () => {
  let workspaceDir: string;
  let checkout: string;
  let cwdSpy: ReturnType<typeof spyOn<typeof process, "cwd">>;
  let originalWorkspaceEnv: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "run-locks-ws-"));
    checkout = mkdtempSync(join(tmpdir(), "run-locks-checkout-"));
    originalWorkspaceEnv = process.env.DEVINTERN_WORKSPACE_DIR;
    process.env.DEVINTERN_WORKSPACE_DIR = workspaceDir;
    // Tests may not chdir; the run lock only reads `process.cwd()`.
    cwdSpy = spyOn(process, "cwd").mockReturnValue(checkout);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    if (originalWorkspaceEnv === undefined) delete process.env.DEVINTERN_WORKSPACE_DIR;
    else process.env.DEVINTERN_WORKSPACE_DIR = originalWorkspaceEnv;
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  test("puts the checkout lock in the workspace home, not the checkout", () => {
    const held = acquireRunLocks([], null);
    try {
      const lockPath = join(checkoutLocksDir(workspaceDir), checkoutLockFileName(checkout));
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(join(checkout, ".devintern-code"))).toBe(false);
    } finally {
      held.release();
    }
  });

  test("a second run in the same checkout fails with the kill hint", () => {
    const held = acquireRunLocks([], null);
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    try {
      expect(() => acquireRunLocks([], null)).toThrow("exit 1");
      expect(errors.join("\n")).toContain("Another instance");
      expect(errors.join("\n")).toContain(`kill ${process.pid}`);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      held.release();
    }
    expect(existsSync(join(checkout, ".devintern-code"))).toBe(false);
  });
});
