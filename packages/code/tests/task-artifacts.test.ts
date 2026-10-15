import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ArtifactStore } from "../src/lib/artifacts/store";
import { RunArtifactRegistry } from "../src/lib/artifacts/registry";
import { runTaskSteps } from "../src/lib/task/step-runner";
import {
  listRunArtifacts,
  readRunArtifact,
  readRunArtifactFile,
} from "../src/lib/observability/task-artifacts";

let dir: string;
let store: ArtifactStore;
let dbPath: string;
const input = (path: string) => ({
  key: "verification",
  path,
  title: "Verification",
  kind: "verification" as const,
  mediaType: "text/markdown",
});
const owner = (runId: number, iteration = 1) => ({
  scope: `run-${runId}`,
  runId,
  step: "verify",
  iteration,
  commitSha: "abc123",
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifacts-"));
  dbPath = join(dir, "queue.db");
  store = new ArtifactStore(dbPath);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("registered artifacts", () => {
  test("snapshots files independently for each run and execution", () => {
    const path = join(dir, "report.md");
    writeFileSync(path, "failed");
    const failed = store.add(input(path), owner(1), [dir]);
    writeFileSync(path, "passed");
    const passed = store.add(input(path), owner(1, 2), [dir]);
    const anotherRun = store.add(input(path), owner(2), [dir]);
    expect(store.read(failed)?.toString()).toBe("failed");
    expect(store.read(passed)?.toString()).toBe("passed");
    expect(store.list(1).map((artifact) => artifact.iteration)).toEqual([1, 2]);
    expect(readRunArtifact(dbPath, 1, anotherRun.id)).toBeNull();
    expect(failed.checksum).not.toBe(passed.checksum);
  });

  test("resolves registration paths against the worktree and records publication independently", async () => {
    writeFileSync(join(dir, "report.md"), "report");
    const registry = new RunArtifactRegistry(dir, dir, dbPath);
    const artifact = (await registry.addFile(input("report.md")))!;
    expect(registry.readText(artifact.id)).toBe("report");
    registry.recordPublication([artifact.id], { status: "failed", message: "Forbidden" });
    expect(registry.list()[0]?.publication?.status).toBe("failed");
    expect(registry.list()[0]?.available).toBe(true);
  });

  test("rejects oversized captures before reading their bytes", () => {
    const path = join(dir, "large.bin");
    writeFileSync(path, "");
    truncateSync(path, 32 * 1024 * 1024 + 1);
    expect(() => store.add(input(path), owner(1), [dir])).toThrow("32 MiB");
  });

  test("resolves references within the same run and commit", () => {
    const path = join(dir, "report.md");
    writeFileSync(path, "![Screen](artifact:screen)");
    const report = store.add(input(path), owner(1), [dir]);
    const image = join(dir, "image.png");
    writeFileSync(image, "image");
    const screen = store.add({ ...input(image), key: "screen", mediaType: "image/png" }, owner(1), [
      dir,
    ]);
    expect(readRunArtifact(dbPath, 1, report.id)?.content).toContain(
      `/artifacts/${screen.id}/file`,
    );
    const other = store.add(
      { ...input(path), key: "other" },
      { ...owner(1), commitSha: "def456" },
      [dir],
    );
    expect(readRunArtifact(dbPath, 1, other.id)?.content).toBe("Screen (artifact unavailable)");
  });

  test("redacts text before storing or downloading it", async () => {
    const path = join(dir, "report.md");
    writeFileSync(path, "\u001b[31msecret=ghp_abcdefghijklmnopqrstuvwxyz\u001b[0m");
    const artifact = store.add(input(path), owner(1), [dir]);
    expect(store.read(artifact)?.toString()).toContain("[redacted]");
    expect(store.read(artifact)?.toString()).not.toContain("\u001b");
    const response = readRunArtifactFile(dbPath, 1, artifact.id, true);
    expect(await response.text()).not.toContain("ghp_");
  });

  test("does not discover unregistered files and retains missing-file metadata", () => {
    const path = join(dir, "report.md");
    writeFileSync(path, "hi");
    expect(listRunArtifacts(dbPath, 1)).toEqual([]);
    const artifact = store.add(input(path), owner(1), [dir]);
    unlinkSync(join(store.root, artifact.id));
    expect(listRunArtifacts(dbPath, 1)[0]?.available).toBe(false);
    expect(readRunArtifact(dbPath, 1, artifact.id)).toBeNull();
  });

  test("rejects escaped source paths, symlinks outside allowed roots, and tampered blobs", () => {
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "outside");
    expect(() => store.add(input(outside), owner(1), [allowed])).toThrow("outside");
    symlinkSync(outside, join(allowed, "link.md"));
    expect(() => store.add(input(join(allowed, "link.md")), owner(1), [allowed])).toThrow(
      "outside",
    );
    const artifact = store.add(input(outside), owner(1), [dir]);
    writeFileSync(join(store.root, artifact.id), "tampered");
    expect(store.read(artifact)).toBeNull();
  });

  test("preserves binaries and forces active formats to download", async () => {
    const path = join(dir, "image.png");
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    writeFileSync(path, bytes);
    const artifact = store.add(
      { ...input(path), kind: "image", mediaType: "image/png" },
      owner(1),
      [dir],
    );
    expect(readRunArtifact(dbPath, 1, artifact.id)?.content).toBeNull();
    const response = readRunArtifactFile(dbPath, 1, artifact.id, false);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const html = join(dir, "report.html");
    writeFileSync(html, "<script>alert(1)</script>");
    const active = store.add({ ...input(html), mediaType: "text/html" }, owner(1), [dir]);
    expect(
      readRunArtifactFile(dbPath, 1, active.id, false).headers.get("content-disposition"),
    ).toStartWith("attachment");
    expect(readRunArtifactFile(dbPath, 2, artifact.id, false).status).toBe(404);
  });

  test("preserves captures from halted steps and tracks loopback executions", async () => {
    const registry = new RunArtifactRegistry(dir, dir, dbPath);
    const path = join(dir, "report.md");
    let calls = 0;
    await runTaskSteps(
      [
        { name: "implement", run: async () => {} },
        {
          name: "verify",
          run: async () => {
            calls++;
            writeFileSync(path, `attempt ${calls}`);
            await registry.addFile(input(path));
            return calls === 1
              ? { kind: "repeat" as const, from: "implement", maxRepeats: 1 }
              : { kind: "halt" as const, reason: "failed" };
          },
        },
      ],
      { artifacts: registry, results: [] },
    );
    expect(registry.list().map((artifact) => [artifact.step, artifact.iteration])).toEqual([
      ["verify", 1],
      ["verify", 2],
    ]);
    expect(registry.readText(registry.list()[0]!.id)).toBe("attempt 1");
  });
});
