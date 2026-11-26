import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { runAddressReviewViaCli } from "../src/lib/acquirers/review-cli";
import { childOutputMode } from "../src/lib/observability/child-output";
import { startWorkerCapture } from "../src/lib/observability/worker-capture";
import type { WorkerCaptureHandle } from "../src/lib/observability/worker-capture";

describe("worker subprocess output", () => {
  let dir: string;
  let fixture: string;
  let capture: WorkerCaptureHandle | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "child-output-"));
    fixture = join(dir, "fake-cli.ts");
    // Stand-in for the devintern CLI: echoes its argv on stdout and stderr.
    writeFileSync(
      fixture,
      [
        'console.log("child-out " + process.argv.slice(2).join(" "));',
        'console.error("child-err line");',
        'process.stdout.write("partial-without-newline");',
      ].join("\n"),
    );
    capture = null;
  });

  afterEach(() => {
    capture?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("inherits stdio without a worker capture and pipes with one", () => {
    expect(childOutputMode()).toBe("inherit");
    expect(childOutputMode("ignore")).toBe("ignore");
    capture = startWorkerCapture(dir);
    expect(childOutputMode()).toBe("pipe");
    expect(childOutputMode("ignore")).toBe("ignore");
  });

  test("address-review child output and the --mention arg reach the worker log", async () => {
    capture = startWorkerCapture(dir);
    const result = await runAddressReviewViaCli("acme/e2e", 47, {
      entrypoint: fixture,
      env: { ...process.env, AGENT_HARNESS: "claude-code" },
      mention: { kind: "issue_comment", id: 501 },
    });
    capture.stop();
    capture = null;

    expect(result).toBe(true);
    const out = readFileSync(join(dir, "worker.stdout.log"), "utf8");
    const err = readFileSync(join(dir, "worker.stderr.log"), "utf8");
    const label = "[address-review https://github.com/acme/e2e/pull/47]";
    expect(out).toContain(
      `${label} child-out address-review https://github.com/acme/e2e/pull/47 --mention issue_comment:501`,
    );
    expect(out).toContain(`${label} partial-without-newline`);
    expect(err).toContain(`${label} child-err line`);
  });
});
