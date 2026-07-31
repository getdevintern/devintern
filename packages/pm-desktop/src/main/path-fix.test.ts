import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { augmentPath } from "./path-fix.ts";

const ORIGINAL_PATH = process.env.PATH;

describe("augmentPath", () => {
  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
  });

  test("appends existing user bin dirs missing from PATH", () => {
    process.env.PATH = "/usr/bin";
    augmentPath();
    const dirs = (process.env.PATH ?? "").split(delimiter);
    expect(dirs[0]).toBe("/usr/bin");
    // At least one common location exists on any dev machine
    expect(dirs.length).toBeGreaterThan(1);
  });

  test("does not duplicate dirs already on PATH", () => {
    const localBin = join(homedir(), ".local", "bin");
    process.env.PATH = ["/usr/bin", localBin].join(delimiter);
    augmentPath();
    const dirs = (process.env.PATH ?? "").split(delimiter);
    expect(dirs.filter((d) => d === localBin).length).toBeLessThanOrEqual(1);
  });
});
