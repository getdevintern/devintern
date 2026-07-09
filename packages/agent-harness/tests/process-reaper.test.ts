/**
 * Tests for the process-group reaper.
 *
 * The behaviour that matters: a long-lived *grandchild* (e.g. a dev server the
 * agent backgrounded) is torn down when we reap the child's process group, even
 * after the direct child has already exited. POSIX-only (process groups).
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnReapable, reapTree } from "../src/process-reaper.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** True while `pid` is a live process we can signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `predicate` until true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

test("spawnReapable runs the child in its own process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-"));
  tmpDirs.push(dir);
  const pgidFile = join(dir, "pgid");

  // The child records its own process-group id. detached → it should be the
  // group leader, i.e. pgid === its own pid.
  const child = spawnReapable("sh", ["-c", `ps -o pgid= -p $$ > "${pgidFile}"`], {
    stdio: "ignore",
  });
  expect(child.pid).toBeDefined();
  await new Promise((resolve) => child.on("exit", resolve));

  const pgid = parseInt(readFileSync(pgidFile, "utf8").trim(), 10);
  expect(pgid).toBe(child.pid!);
});

test("a grandchild left running is swept automatically when the child exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-"));
  tmpDirs.push(dir);
  const pidFile = join(dir, "grandchild.pid");

  // The child backgrounds a long sleep (the "orphaned dev server"), records its
  // PID, and exits immediately. No manual reaping — spawnReapable should sweep
  // the leftover grandchild on the child's exit.
  const child = spawnReapable("sh", ["-c", `sleep 300 & echo $! > "${pidFile}"; exit 0`], {
    stdio: "ignore",
  });

  await new Promise((resolve) => child.on("exit", resolve));

  const grandchildPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  expect(Number.isInteger(grandchildPid)).toBe(true);
  expect(await waitFor(() => !isAlive(grandchildPid))).toBe(true);
});

test("reapTree kills a still-running child and its children together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-"));
  tmpDirs.push(dir);
  const pidFile = join(dir, "grandchild.pid");

  // The child stays alive (its own long sleep) with a backgrounded grandchild,
  // simulating an agent still working while it has spawned a dev server.
  const child = spawnReapable("sh", ["-c", `sleep 300 & echo $! > "${pidFile}"; sleep 300`], {
    stdio: "ignore",
  });

  // Wait until the grandchild PID has been recorded.
  expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")).toBe(
    true,
  );
  const grandchildPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  expect(isAlive(child.pid!)).toBe(true);
  expect(isAlive(grandchildPid)).toBe(true);

  // Reaping the group (negative PID) takes out both the child and grandchild.
  reapTree(child, "SIGKILL");

  expect(await waitFor(() => !isAlive(child.pid!))).toBe(true);
  expect(await waitFor(() => !isAlive(grandchildPid))).toBe(true);
});
