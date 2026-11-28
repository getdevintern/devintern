/**
 * Shared helpers for `devintern worker doctor` tracker tests: render a `.env`,
 * run doctor while asserting no secret leaks, and assert report lines.
 */

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { proxyEnvironment, startRecordingProxy } from "./recording-proxy";
import type { RecordingProxy } from "./recording-proxy";
import { WorkerFixture } from "./worker";
import type { WorkerAddResult } from "./worker";

/** Doctor's closing line when any check fails. */
export const NOT_READY = "❌ Not ready — the worker would sit idle or fail. Fix the checks above.";

/** Doctor's closing line when every check passes. */
export const READY = "✅ Everything looks good — start the worker with `devintern worker`.";

/** Hint under a failed `[defaults].task_query` dry run. */
export const DEFAULTS_HINT =
  "💡 Fix [defaults].task_query in workspace.toml (renamed status, project, or field?)";

/** A random fake credential with a recognizable prefix. */
export const randomToken = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;

/** Render `KEY=value` lines for a workspace or team `.env` file. */
export function dotenv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
}

/** Run doctor and assert no secret (raw or URL-encoded) reached stdout or stderr. */
export async function doctorWithout(
  worker: WorkerFixture,
  secrets: string[],
  args: string[] = [],
): Promise<WorkerAddResult> {
  const result = await worker.runCli(["worker", "doctor", ...args]);
  for (const output of [result.stdout, result.stderr]) {
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(encodeURIComponent(secret));
    }
  }
  return result;
}

/** Assert every line appears in doctor's stdout. */
export function expectLines(result: WorkerAddResult, lines: string[]): void {
  for (const line of lines) expect(result.stdout).toContain(line);
}

/**
 * Start a recording proxy and a prepared (never started) worker fixture, run
 * `body`, then assert doctor created no state database or lock and nothing
 * reached the proxy. The worker, every fake, and the proxy are always cleaned
 * up, each step attempted even when an earlier one throws.
 */
export async function withDoctorWorker(
  options: { prefix: string; tracker: string; taskQuery?: string },
  fakes: Array<{ cleanup(): Promise<void> }>,
  body: (worker: WorkerFixture, proxy: RecordingProxy) => Promise<void>,
): Promise<void> {
  let proxy: RecordingProxy | undefined;
  const worker = new WorkerFixture({
    rootPrefix: options.prefix,
    tracker: options.tracker,
    ...(options.taskQuery
      ? { workspaceTomlExtra: `task_query = ${JSON.stringify(options.taskQuery)}` }
      : {}),
  });
  try {
    proxy = await startRecordingProxy();
    Object.assign(worker.env, proxyEnvironment(proxy.url));
    await worker.prepare();
    await body(worker, proxy);
    expect(existsSync(worker.dbPath)).toBe(false);
    expect(existsSync(worker.lockFile)).toBe(false);
    expect(proxy.requests()).toEqual([]);
  } finally {
    try {
      await worker.dispose();
    } finally {
      try {
        await Promise.allSettled(fakes.map((fake) => fake.cleanup()));
      } finally {
        await proxy?.close();
      }
    }
  }
}
