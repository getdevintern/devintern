import { describe, expect, test } from "bun:test";

import { parseReportArgs } from "../src/lib/report/cli";

describe("report CLI parsing", () => {
  test("parses the common report flags", () => {
    const options = parseReportArgs([
      "--title",
      "Worker crash",
      "--body",
      "Steps",
      "--last",
      "--log",
      "a.log",
      "--log",
      "b.log",
      "--no-logs",
      "--no-diagnostics",
      "--share-identifiers",
      "--yes",
      "--json",
    ]);
    expect(options.title).toBe("Worker crash");
    expect(options.body).toBe("Steps");
    expect(options.last).toBe(true);
    expect(options.logPaths).toEqual(["a.log", "b.log"]);
    expect(options.logs).toBe(false);
    expect(options.diagnostics).toBe(false);
    expect(options.shareIdentifiers).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.json).toBe(true);
  });

  test("parses subcommands", () => {
    expect(parseReportArgs(["list"]).list).toBe(true);
    expect(parseReportArgs(["show", "abcd1234"]).show).toBe("abcd1234");
  });

  test("rejects missing and unknown values", () => {
    expect(() => parseReportArgs(["--title"])).toThrow("needs a value");
    expect(() => parseReportArgs(["--nope"])).toThrow("Unknown option");
    expect(() => parseReportArgs(["--run", "nope"])).toThrow("positive integer");
  });
});
