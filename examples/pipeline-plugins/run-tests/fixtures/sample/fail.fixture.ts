import { expect, test } from "bun:test";

// Deliberately wrong so the example can reproduce the failed-check halt path.
test("addition is broken on purpose", () => {
  expect(1 + 1).toBe(3);
});
