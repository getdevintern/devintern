import { describe, expect, test } from "bun:test";

import { classifyFailure, resolveAutoReportMode } from "../src/lib/report/auto";

describe("automatic report policy", () => {
  test("classifies known user-actionable failures as user errors", () => {
    expect(classifyFailure(new Error("Invalid API token for tracker"))).toBe("user");
    expect(classifyFailure(new Error("Request failed with 401"))).toBe("user");
    const harness = new Error("agent CLI is not configured");
    harness.name = "HarnessUnavailableError";
    expect(classifyFailure(harness)).toBe("user");
  });

  test("classifies network failures as external", () => {
    expect(classifyFailure(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("external");
    expect(classifyFailure(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe("external");
  });

  test("ignores usage limits and cancellation", () => {
    const usage = new Error("Agent usage limit reached");
    usage.name = "UsageLimitError";
    expect(classifyFailure(usage)).toBe("ignored");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyFailure(abort)).toBe("ignored");
  });

  test("treats unexpected errors as internal", () => {
    expect(classifyFailure(new TypeError("cannot read properties of undefined"))).toBe("internal");
    expect(classifyFailure(new Error("artifact registry returned a malformed row"))).toBe(
      "internal",
    );
  });

  test("defaults to internal and honors the environment override", () => {
    expect(resolveAutoReportMode(undefined, {})).toBe("internal");
    expect(resolveAutoReportMode("off", {})).toBe("off");
    expect(resolveAutoReportMode("off", { DEVINTERN_AUTO_REPORT: "all" })).toBe("all");
    expect(resolveAutoReportMode("all", { DEVINTERN_AUTO_REPORT: "nonsense" })).toBe("all");
  });
});
