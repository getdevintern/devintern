import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ArtifactStore } from "../src/lib/artifacts/store";
import {
  DashboardData,
  handleRunArtifact,
  handleRunArtifacts,
  handleRunDetail,
} from "../src/lib/observability/dashboard-api";
import { RunStore } from "../src/lib/state/run-recorder";

let dir: string;
let dbPath: string;
let data: DashboardData;
let artifacts: ArtifactStore;
let runs: RunStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dashboard-artifacts-"));
  dbPath = join(dir, "queue.db");
  runs = new RunStore(dbPath);
  artifacts = new ArtifactStore(dbPath);
  data = new DashboardData({ dbPath });
});
afterEach(() => {
  data.close();
  runs.close();
  artifacts.close();
  rmSync(dir, { recursive: true, force: true });
});
function capture(runId: number, content: string) {
  const path = join(dir, "report.md");
  writeFileSync(path, content);
  return artifacts.add(
    {
      key: "explanation",
      path,
      title: "Explanation",
      kind: "explanation",
      mediaType: "text/markdown",
    },
    { scope: `run-${runId}`, runId, step: "custom-name", iteration: 1 },
    [dir],
  );
}
describe("dashboard artifacts", () => {
  test("isolates different attempts of the same task", () => {
    const first = runs.createRun({ origin: "task", taskKey: "DEV-1" });
    const old = capture(first, "old");
    const second = runs.createRun({ origin: "task", taskKey: "DEV-1" });
    const current = capture(second, "current");
    expect(
      (handleRunDetail(data, String(first)).body as { artifacts: { id: string }[] }).artifacts.map(
        (entry) => entry.id,
      ),
    ).toEqual([old.id]);
    expect(
      (handleRunArtifact(data, String(first), old.id).body as { content: string }).content,
    ).toBe("old");
    expect(handleRunArtifact(data, String(first), current.id).status).toBe(404);
    expect(handleRunArtifact(data, String(first), "../report.md").status).toBe(404);
  });
  test("supports runs without task keys", () => {
    const id = runs.createRun({ origin: "pr_mention" });
    const artifact = capture(id, "review");
    expect(
      (handleRunArtifacts(data, String(id)).body as { artifacts: { id: string }[] }).artifacts[0]
        ?.id,
    ).toBe(artifact.id);
  });
  test("rejects malformed IDs and missing runs", () => {
    expect(handleRunArtifacts(data, "abc").status).toBe(400);
    expect(handleRunArtifact(data, "abc", "anything").status).toBe(400);
    expect(handleRunArtifacts(data, "999999").status).toBe(404);
    expect(handleRunArtifact(data, "999999", "anything").status).toBe(404);
  });
});
