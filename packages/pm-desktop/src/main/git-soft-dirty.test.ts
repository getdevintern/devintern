import { describe, expect, test } from "bun:test";
import {
  classifyPmWorkingTree,
  isPmGitignorePath,
  isPmLocalPath,
  isSoftDirtyEntry,
  parsePorcelainLine,
} from "./git-soft-dirty.ts";

describe("parsePorcelainLine", () => {
  test("parses modified and untracked paths", () => {
    expect(parsePorcelainLine(" M .gitignore")).toEqual({ xy: " M", path: ".gitignore" });
    expect(parsePorcelainLine("?? .gitignore")).toEqual({ xy: "??", path: ".gitignore" });
    expect(parsePorcelainLine("!! .devintern-pm/.env")).toEqual({
      xy: "!!",
      path: ".devintern-pm/.env",
    });
  });

  test("parses rename destination", () => {
    expect(parsePorcelainLine("R  old.txt -> new.txt")).toEqual({ xy: "R ", path: "new.txt" });
  });

  test("unquotes escaped paths", () => {
    expect(parsePorcelainLine('?? "foo\\nbar"')).toEqual({ xy: "??", path: "foo\nbar" });
    expect(parsePorcelainLine(' M "my file.txt"')).toEqual({ xy: " M", path: "my file.txt" });
  });

  test("unquotes octal escapes", () => {
    // Space as octal \040
    expect(parsePorcelainLine('?? "foo\\040bar"')).toEqual({ xy: "??", path: "foo bar" });
  });
});

describe("path helpers", () => {
  test("recognizes only repo-root .gitignore as PM soft-dirty path", () => {
    expect(isPmGitignorePath(".gitignore")).toBe(true);
    expect(isPmGitignorePath("./.gitignore")).toBe(true);
    expect(isPmGitignorePath("packages/pm/.gitignore")).toBe(false);
    expect(isPmGitignorePath("src/app.ts")).toBe(false);
  });

  test("recognizes .devintern-pm tree as PM local path", () => {
    expect(isPmLocalPath(".devintern-pm")).toBe(true);
    expect(isPmLocalPath(".devintern-pm/")).toBe(true);
    expect(isPmLocalPath(".devintern-pm/.env")).toBe(true);
    expect(isPmLocalPath(".devintern-pm/tasks/foo.md")).toBe(true);
    expect(isPmLocalPath("pkg/.devintern-pm/tasks/foo.md")).toBe(false);
    expect(isPmLocalPath("src/app.ts")).toBe(false);
  });
});

describe("isSoftDirtyEntry", () => {
  test("treats repo-root .gitignore changes as soft", () => {
    expect(isSoftDirtyEntry({ xy: " M", path: ".gitignore" })).toBe(true);
    expect(isSoftDirtyEntry({ xy: "??", path: ".gitignore" })).toBe(true);
  });

  test("treats nested .gitignore as hard (not PM soft-dirty)", () => {
    expect(isSoftDirtyEntry({ xy: "??", path: "pkg/.gitignore" })).toBe(false);
    expect(isSoftDirtyEntry({ xy: " M", path: "packages/pm/.gitignore" })).toBe(false);
  });

  test("does not treat .devintern-pm paths as soft (they are skipped instead)", () => {
    expect(isSoftDirtyEntry({ xy: "!!", path: ".devintern-pm/.env" })).toBe(false);
    expect(isSoftDirtyEntry({ xy: "??", path: ".devintern-pm/.env" })).toBe(false);
    expect(isSoftDirtyEntry({ xy: "??", path: ".devintern-pm/tasks/foo.md" })).toBe(false);
  });

  test("treats ordinary source changes as hard", () => {
    expect(isSoftDirtyEntry({ xy: " M", path: "src/app.ts" })).toBe(false);
  });
});

describe("classifyPmWorkingTree", () => {
  test("empty status is clean", () => {
    expect(classifyPmWorkingTree([])).toBe("clean");
    expect(classifyPmWorkingTree([""])).toBe("clean");
  });

  test("only repo-root .gitignore is soft-dirty", () => {
    expect(classifyPmWorkingTree([" M .gitignore"])).toBe("soft-dirty");
    expect(classifyPmWorkingTree(["?? .gitignore"])).toBe("soft-dirty");
  });

  test("nested .gitignore is hard-dirty", () => {
    expect(classifyPmWorkingTree([" M packages/foo/.gitignore"])).toBe("hard-dirty");
  });

  test("ignored .devintern-pm paths alone are clean", () => {
    expect(
      classifyPmWorkingTree(["!! .devintern-pm/.env", "!! .devintern-pm/.auth-session.json"]),
    ).toBe("clean");
  });

  test("untracked .devintern-pm tasks alone are clean", () => {
    expect(classifyPmWorkingTree(["?? .devintern-pm/"])).toBe("clean");
    expect(
      classifyPmWorkingTree([
        "?? .devintern-pm/tasks/2026-08-10T07-02-07-6t8k-keep-devintern-pm-desktop-dependencies-current-for.md",
      ]),
    ).toBe("clean");
  });

  test("gitignore plus .devintern-pm leftovers is soft-dirty (not hard)", () => {
    expect(classifyPmWorkingTree([" M .gitignore", "!! .devintern-pm/.env"])).toBe("soft-dirty");
    expect(classifyPmWorkingTree([" M .gitignore", "?? .devintern-pm/"])).toBe("soft-dirty");
    expect(
      classifyPmWorkingTree([
        " M .gitignore",
        "?? .devintern-pm/tasks/2026-08-10T07-02-07-6t8k-keep-devintern-pm-desktop-dependencies-current-for.md",
      ]),
    ).toBe("soft-dirty");
  });

  test("ambient ignored paths do not make the tree hard-dirty", () => {
    expect(classifyPmWorkingTree(["!! node_modules/", "!! dist/"])).toBe("clean");
    expect(
      classifyPmWorkingTree([
        "!! node_modules/",
        "!! dist/",
        " M .gitignore",
        "!! .devintern-pm/.env",
      ]),
    ).toBe("soft-dirty");
    expect(classifyPmWorkingTree(["!! node_modules/", "!! .devintern-pm/.env"])).toBe("clean");
  });

  test("any non-soft path makes the tree hard-dirty", () => {
    expect(classifyPmWorkingTree([" M .gitignore", " M src/app.ts"])).toBe("hard-dirty");
    expect(classifyPmWorkingTree(["?? README.md"])).toBe("hard-dirty");
    expect(classifyPmWorkingTree(["!! node_modules/", " M src/app.ts"])).toBe("hard-dirty");
  });

  test("tracked file under .devintern-pm does not gate updates", () => {
    expect(classifyPmWorkingTree([" M .devintern-pm/tasks/foo.md"])).toBe("clean");
  });

  test("unparseable non-empty porcelain fails closed as hard-dirty", () => {
    // Too short to parse as XY + path
    expect(classifyPmWorkingTree(["XY"])).toBe("hard-dirty");
    expect(classifyPmWorkingTree(["??"])).toBe("hard-dirty");
    // Soft-dirty plus garbage must not stay soft
    expect(classifyPmWorkingTree([" M .gitignore", "XY"])).toBe("hard-dirty");
  });
});
