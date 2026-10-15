import { expect, test } from "bun:test";
import { greeting } from "../src/greeting";

test("provides a greeting", () => {
  expect(greeting.startsWith("Hello")).toBe(true);
});
