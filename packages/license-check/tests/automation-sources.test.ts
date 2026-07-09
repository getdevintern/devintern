import { describe, expect, test } from "bun:test";
import {
  getAllowedBenefits,
  getAllowedBenefitIds,
  isAutomationSource,
} from "../src/index.ts";

describe("isAutomationSource", () => {
  test("the two entitlement sources qualify for automation", () => {
    expect(isAutomationSource("solo-automation")).toBe(true);
    expect(isAutomationSource("team-automation")).toBe(true);
  });

  test("undefined does not qualify", () => {
    expect(isAutomationSource(undefined)).toBe(false);
  });
});

describe("ALLOWED_BENEFITS (FSL model)", () => {
  test("devintern/code grants exactly the solo and team automation benefits", () => {
    const benefits = getAllowedBenefits("devintern/code");
    expect(benefits).toHaveLength(2);

    const sources = benefits.map((b) => b.source).sort();
    expect(sources).toEqual(["solo-automation", "team-automation"]);

    // every listed benefit is an automation benefit
    expect(benefits.every((b) => isAutomationSource(b.source))).toBe(true);
  });

  test("benefit ids are the Polar License Key benefits", () => {
    expect(getAllowedBenefitIds("devintern/code")).toEqual([
      "d15d2b30-390b-45e3-8adf-b6e32080b704", // Supporter -> solo-automation
      "5d9628d5-2ee8-44eb-9b32-f75c4c4daf0a", // Team/Business -> team-automation
    ]);
  });

  test("pm has no benefits (interactive use is free under FSL)", () => {
    expect(getAllowedBenefits("devintern/pm")).toEqual([]);
  });

  test("unknown product keys return no benefits", () => {
    expect(getAllowedBenefits("devintern/nope")).toEqual([]);
  });
});
