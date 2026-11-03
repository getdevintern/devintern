import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runAddressReviewUrlViaCli,
  runResolveConflictsUrlViaCli,
  serializePrRun,
} from "../src/lib/acquirers/review-polling";

test.each(["review", "conflict"] as const)("%s URL job stops on cancellation", async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "gitlab-cancel-"));
  const entrypoint = join(dir, "child.ts");
  const marker = join(dir, "started");
  writeFileSync(
    entrypoint,
    'import { writeFileSync } from "fs"; writeFileSync(process.env.STARTED!, "yes"); setInterval(() => {}, 1000);',
  );
  const controller = new AbortController();
  const opts = {
    entrypoint,
    outputStdio: "ignore" as const,
    signal: controller.signal,
    env: { ...process.env, STARTED: marker },
  };
  const run =
    kind === "review"
      ? runAddressReviewUrlViaCli("https://gitlab.com/a/b/-/merge_requests/1", dir, opts)
      : runResolveConflictsUrlViaCli("https://gitlab.com/a/b/-/merge_requests/1", dir, opts);
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true);
    controller.abort();
    const result = await run;
    // A cancelled review is not a failed review: report the drain abort so the
    // caller keeps the delivery retryable instead of marking it handled.
    if (kind === "review") expect(result).toBe("interrupted");
    else expect(result).toMatchObject({ outcome: "failed" });
  } finally {
    controller.abort();
    await run;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled review waiting on the change lock never spawns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gitlab-queued-"));
  const marker = join(dir, "spawned");
  const entrypoint = join(dir, "child.ts");
  writeFileSync(
    entrypoint,
    'import { writeFileSync } from "fs"; writeFileSync(process.env.STARTED!, "yes");',
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = serializePrRun(dir, 0, () => gate);
  const controller = new AbortController();
  const second = runAddressReviewUrlViaCli("https://gitlab.com/a/b/-/merge_requests/1", dir, {
    signal: controller.signal,
    entrypoint,
    outputStdio: "ignore",
    env: { ...process.env, STARTED: marker },
  });
  controller.abort();
  release();
  try {
    await first;
    // The queued run never spawned; report the abort so callers retry it.
    expect(await second).toBe("interrupted");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
