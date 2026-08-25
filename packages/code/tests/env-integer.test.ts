import { afterEach, describe, expect, test } from "bun:test";

import { parseEnvInteger } from "../src/lib/env-integer";

const ENV_NAME = "DEVINTERN_TEST_INTEGER";
const originalValue = process.env[ENV_NAME];

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = originalValue;
});

describe("parseEnvInteger", () => {
  test("uses the default when the value is unset or invalid", () => {
    delete process.env[ENV_NAME];
    expect(parseEnvInteger(ENV_NAME, 3)).toBe(3);

    for (const value of ["", "wat", "1.5", "2attempts", "Infinity", "NaN"]) {
      process.env[ENV_NAME] = value;
      expect(parseEnvInteger(ENV_NAME, 3)).toBe(3);
    }
  });

  test("accepts zero at the default non-negative minimum", () => {
    process.env[ENV_NAME] = "0";
    expect(parseEnvInteger(ENV_NAME, 3)).toBe(0);
  });

  test("rejects values below the configured minimum", () => {
    process.env[ENV_NAME] = "-1";
    expect(parseEnvInteger(ENV_NAME, 30, { min: 0 })).toBe(30);
  });

  test("rejects integers beyond the safe range", () => {
    process.env[ENV_NAME] = "9007199254740992";
    expect(parseEnvInteger(ENV_NAME, 3)).toBe(3);
  });

  test("honors an explicit inclusive maximum", () => {
    process.env[ENV_NAME] = "11";
    expect(parseEnvInteger(ENV_NAME, 3, { max: 10 })).toBe(3);
    process.env[ENV_NAME] = "10";
    expect(parseEnvInteger(ENV_NAME, 3, { max: 10 })).toBe(10);
  });
});
