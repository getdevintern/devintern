import { describe, expect, test } from "bun:test";

import { shouldClearBaseSyncExhaustion } from "../src/lib/review/cli";

describe("shouldClearBaseSyncExhaustion", () => {
  test("a --no-push resolve never clears the remote escalation", () => {
    expect(shouldClearBaseSyncExhaustion({ outcome: "resolved" }, true)).toBe(false);
    expect(shouldClearBaseSyncExhaustion({ outcome: "clean" }, true)).toBe(false);
  });

  test("a pushed clean or resolved merge clears it", () => {
    expect(shouldClearBaseSyncExhaustion({ outcome: "resolved" }, false)).toBe(true);
    expect(shouldClearBaseSyncExhaustion({ outcome: "clean" }, false)).toBe(true);
  });

  test("a skipped result clears it with or without --no-push", () => {
    expect(shouldClearBaseSyncExhaustion({ outcome: "skipped" }, true)).toBe(true);
    expect(shouldClearBaseSyncExhaustion({ outcome: "skipped" }, false)).toBe(true);
  });

  test("failed and deferred results leave it in place", () => {
    expect(shouldClearBaseSyncExhaustion({ outcome: "failed" }, false)).toBe(false);
    expect(shouldClearBaseSyncExhaustion({ outcome: "deferred" }, false)).toBe(false);
  });
});
