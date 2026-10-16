import { expect, test } from "bun:test";
import { FixtureWorkspace } from "../../helpers/fixture-workspace";

class ExposedWorkspace extends FixtureWorkspace {
  pointAt(taskKey: string): void {
    this.useTaskKey(taskKey);
  }
}

test("feature branch, task key and owned branches derive from the actual tracker key", () => {
  const run = new ExposedWorkspace();
  try {
    expect(run.taskKey).toBe(run.id);
    expect(run.head).toBe(`feature/${run.id}`);
    expect(run.ownedBranches.has(run.base)).toBe(true);
    expect(run.ownedBranches.has(run.head)).toBe(true);

    run.pointAt("12345");
    expect(run.taskKey).toBe("12345");
    expect(run.head).toBe("feature/12345");
    expect(run.ownedBranches.has("feature/12345")).toBe(true);
    // The synthetic Markdown branch is replaced, not merely supplemented.
    expect(run.ownedBranches.has(`feature/${run.id}`)).toBe(false);
    expect(() => run.pointAt("   ")).toThrow("empty");
  } finally {
    run.dispose();
  }
});
