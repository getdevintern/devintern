import { describe, expect, test } from "bun:test";

import {
  RowParseError,
  optionalEnum,
  optionalNumber,
  optionalString,
  parseRowObject,
  requireEnum,
  requireNumber,
  requireString,
} from "../src/lib/state/row-parse";

describe("parseRowObject", () => {
  test("returns the row object unchanged", () => {
    const row = { id: "x" };
    expect(parseRowObject(row, "ctx")).toBe(row);
  });

  test("rejects null, undefined, primitives, and arrays", () => {
    for (const value of [null, undefined, 42, "str", true, [], 10n]) {
      expect(() => parseRowObject(value, "ctx")).toThrow(RowParseError);
    }
  });
});

describe("requireString / optionalString", () => {
  test("requireString returns the string and rejects every non-string", () => {
    expect(requireString({ value: "hi" }, "value", "ctx")).toBe("hi");
    for (const value of [null, undefined, 42, true, {}, [], 10n]) {
      expect(() => requireString({ value }, "value", "ctx")).toThrow(RowParseError);
    }
  });

  test("requireString treats a missing column as undefined and rejects it", () => {
    expect(() => requireString({}, "value", "ctx")).toThrow(RowParseError);
    expect(() => requireString({}, "value", "ctx")).toThrow('column "value" must be a string');
  });

  test("optionalString maps SQL NULL and a missing column to undefined", () => {
    expect(optionalString({ value: null }, "value", "ctx")).toBeUndefined();
    expect(optionalString({}, "value", "ctx")).toBeUndefined();
  });

  test("optionalString returns a present string but rejects a present wrong type", () => {
    expect(optionalString({ value: "ok" }, "value", "ctx")).toBe("ok");
    expect(() => optionalString({ value: 42 }, "value", "ctx")).toThrow(RowParseError);
  });
});

describe("requireNumber / optionalNumber", () => {
  test("accepts finite numbers including zero and negatives", () => {
    expect(requireNumber({ n: 0 }, "n", "ctx")).toBe(0);
    expect(requireNumber({ n: -1.5 }, "n", "ctx")).toBe(-1.5);
  });

  test("rejects strings, booleans, NULL, undefined, and missing columns", () => {
    for (const value of ["1", true, null, undefined, {}, 10n]) {
      expect(() => requireNumber({ n: value }, "n", "ctx")).toThrow(RowParseError);
    }
    expect(() => requireNumber({}, "n", "ctx")).toThrow(RowParseError);
  });

  test("rejects non-finite numbers (NaN, +Infinity, -Infinity)", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => requireNumber({ n: value }, "n", "ctx")).toThrow(RowParseError);
      expect(() => requireNumber({ n: value }, "n", "ctx")).toThrow(
        'column "n" must be a finite number',
      );
    }
  });

  test("optionalNumber maps SQL NULL and a missing column to undefined", () => {
    expect(optionalNumber({ n: null }, "n", "ctx")).toBeUndefined();
    expect(optionalNumber({}, "n", "ctx")).toBeUndefined();
    expect(optionalNumber({ n: 5 }, "n", "ctx")).toBe(5);
  });

  test("optionalNumber still rejects non-finite and non-numeric values", () => {
    expect(() => optionalNumber({ n: Infinity }, "n", "ctx")).toThrow(RowParseError);
    expect(() => optionalNumber({ n: "5" }, "n", "ctx")).toThrow(RowParseError);
  });
});

const STATUSES = ["pending", "completed", "failed"] as const;

describe("requireEnum / optionalEnum", () => {
  test("accepts allowed values and rejects unknown ones", () => {
    expect(requireEnum(STATUSES, "pending", "status", "ctx")).toBe("pending");
    for (const value of ["bogus", "PENDING", "", null, undefined, 1]) {
      expect(() => requireEnum(STATUSES, value, "status", "ctx")).toThrow(RowParseError);
    }
  });

  test("lists the allowed values and the offending value in the error", () => {
    expect(() => requireEnum(STATUSES, "bogus", "status", "ctx")).toThrow(
      'column "status" must be one of pending, completed, failed, got string "bogus"',
    );
  });

  test("optionalEnum maps SQL NULL and a missing column to undefined", () => {
    expect(optionalEnum(STATUSES, null, "status", "ctx")).toBeUndefined();
    expect(optionalEnum(STATUSES, undefined, "status", "ctx")).toBeUndefined();
    expect(optionalEnum(STATUSES, "failed", "status", "ctx")).toBe("failed");
  });

  test("optionalEnum still rejects an unknown present value", () => {
    expect(() => optionalEnum(STATUSES, "bogus", "status", "ctx")).toThrow(RowParseError);
  });
});

describe("describe formatting in error messages", () => {
  test("describes null and undefined", () => {
    expect(() => requireString({ value: null }, "value", "ctx")).toThrow("got null");
    expect(() => requireString({}, "value", "ctx")).toThrow("got undefined");
  });

  test("describes strings with JSON quoting", () => {
    expect(() => requireNumber({ n: "one" }, "n", "ctx")).toThrow('got string "one"');
  });

  test("describes numbers and booleans by typeof", () => {
    expect(() => requireString({ value: 42 }, "value", "ctx")).toThrow("got number");
    expect(() => requireString({ value: true }, "value", "ctx")).toThrow("got boolean");
  });

  test("describes blobs, plain objects, and arrays as object", () => {
    expect(() => requireString({ value: {} }, "value", "ctx")).toThrow("got object");
    expect(() => requireString({ value: [] }, "value", "ctx")).toThrow("got object");
    expect(() => requireString({ value: new Uint8Array([0, 1]) }, "value", "ctx")).toThrow(
      "got object",
    );
    expect(() => parseRowObject([], "ctx")).toThrow("got object");
  });
});
