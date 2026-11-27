/**
 * Shared helpers for `devintern worker doctor` tracker tests: render a `.env`,
 * run doctor while asserting no secret leaks, and assert report lines.
 */

import { expect } from "bun:test";
import type { WorkerAddResult, WorkerFixture } from "./worker";

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
