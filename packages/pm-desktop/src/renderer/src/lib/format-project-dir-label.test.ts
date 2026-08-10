import { describe, expect, test } from "bun:test";
import { formatProjectDirLabel, projectDirBasename } from "./format-project-dir-label.ts";

describe("formatProjectDirLabel", () => {
  test("projectDirBasename returns the last segment", () => {
    expect(projectDirBasename("/home/me/app/frontend")).toBe("frontend");
    expect(projectDirBasename("C:\\Users\\me\\app\\frontend")).toBe("frontend");
  });

  test("returns basename when unique among siblings", () => {
    const among = ["/a/frontend", "/b/backend"];
    expect(formatProjectDirLabel("/a/frontend", among)).toBe("frontend");
  });

  test("adds parent suffix when basenames collide", () => {
    const among = ["/work/app/frontend", "/work/svc/frontend", "/work/other"];
    expect(formatProjectDirLabel("/work/app/frontend", among)).toBe("app/frontend");
    expect(formatProjectDirLabel("/work/svc/frontend", among)).toBe("svc/frontend");
    expect(formatProjectDirLabel("/work/other", among)).toBe("other");
  });
});
