import { describe, expect, test } from "bun:test";
import { parseRendererErrorReport } from "./ipc-contract.ts";

describe("parseRendererErrorReport", () => {
  test("accepts a valid report", () => {
    const parsed = parseRendererErrorReport({
      kind: "react",
      message: "Cannot read properties of undefined",
      stack: "Error: Cannot read properties...\n    at render",
      componentStack: "  at App\n  at ErrorBoundary",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("react");
    expect(parsed?.message).toContain("Cannot read properties");
    expect(parsed?.stack).toContain("at render");
    expect(parsed?.componentStack).toContain("at App");
  });

  test("accepts minimal reports without stacks", () => {
    expect(parseRendererErrorReport({ kind: "error", message: "boom" })).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  test("rejects malformed payloads", () => {
    expect(parseRendererErrorReport(null)).toBeNull();
    expect(parseRendererErrorReport(undefined)).toBeNull();
    expect(parseRendererErrorReport("boom")).toBeNull();
    expect(parseRendererErrorReport(["boom"])).toBeNull();
    expect(parseRendererErrorReport({ message: "no kind" })).toBeNull();
    expect(parseRendererErrorReport({ kind: "nonsense", message: "boom" })).toBeNull();
    expect(parseRendererErrorReport({ kind: "error" })).toBeNull();
    expect(parseRendererErrorReport({ kind: "error", message: "   " })).toBeNull();
    expect(parseRendererErrorReport({ kind: "error", message: 42 })).toBeNull();
  });

  test("bounds the size of message and stacks", () => {
    const parsed = parseRendererErrorReport({
      kind: "unhandledrejection",
      message: "x".repeat(20_000),
      stack: "s".repeat(40_000),
    });
    expect(parsed?.message.length).toBe(8_000);
    expect(parsed?.stack?.length).toBe(16_000);
  });
});
