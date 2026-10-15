import { expect } from "bun:test";
import type { FixtureWorkspace } from "./fixture-workspace";

export async function withScenario<
  T extends FixtureWorkspace & { setup(token: string): Promise<void>; cleanup(): Promise<void> },
>(run: T, token: string, check: (run: T) => Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  try {
    await run.setup(token);
    await check(run);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await run.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, `Lifecycle scenario failed: ${run.id}`);
}

export async function assertUndelivered(
  run: FixtureWorkspace,
  baseSha: string | undefined,
): Promise<void> {
  expect(await run.remoteSha(run.base)).toBe(baseSha);
  expect(await run.remoteSha(run.head)).toBeUndefined();
  const records = run.runRecords();
  expect(records).toHaveLength(1);
  expect(records[0].status).toBe("failed");
  expect(records[0].pr_url).toBeNull();
}

export async function assertCollision(run: FixtureWorkspace): Promise<string> {
  const baseSha = await run.remoteSha(run.base);
  const { existingSha, attemptHead } = await run.seedBranchCollision();
  await run.runCli();
  expect(await run.git("branch", "--show-current")).toBe(attemptHead);
  expect(await run.remoteSha(run.head)).toBe(existingSha);
  expect(await run.git("show", `origin/${run.head}:existing-work.txt`)).toBe(
    "Preserve this existing implementation.",
  );
  expect(await run.remoteSha(attemptHead)).toBe(await run.git("rev-parse", "HEAD"));
  expect(await run.remoteSha(run.base)).toBe(baseSha);
  expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
  return attemptHead;
}
