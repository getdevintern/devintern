import { describe, expect, test } from "bun:test";
import { normalizeTaskKeys } from "../src/lib/normalize-task-keys";

describe("normalizeTaskKeys", () => {
  test("linear uppercases every identifier in a multi-task invocation", () => {
    expect(normalizeTaskKeys(["dan-6", "dan-7", "dan-8"], "linear")).toEqual([
      "DAN-6",
      "DAN-7",
      "DAN-8",
    ]);
  });

  test("linear unwraps issue URLs mixed with bare identifiers", () => {
    expect(
      normalizeTaskKeys(
        ["dan-6", "https://linear.app/acme/issue/DAN-7/fix-login", "DAN-8"],
        "linear",
      ),
    ).toEqual(["DAN-6", "DAN-7", "DAN-8"]);
  });

  test("linear leaves non-identifier arguments unchanged", () => {
    expect(normalizeTaskKeys(["not-a-ticket", "dan-6"], "linear")).toEqual([
      "not-a-ticket",
      "DAN-6",
    ]);
  });

  test("jira keeps keys as-is", () => {
    expect(normalizeTaskKeys(["PROJ-1", "PROJ-2"], "jira")).toEqual(["PROJ-1", "PROJ-2"]);
  });

  test("github unwraps issue numbers and URLs", () => {
    expect(
      normalizeTaskKeys(["12", "#13", "https://github.com/acme/web/issues/14"], "github"),
    ).toEqual(["12", "13", "14"]);
  });
});
