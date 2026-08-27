import { describe, expect, test } from "bun:test";

import {
  getPreset,
  listPresetNames,
  listPresets,
  registerPreset,
  resolvePresetOutputMode,
} from "../src/lib/automations/presets";
import { PRESET_VERSION } from "../src/lib/automations/docs-drift-guard/definition";

describe("preset registry", () => {
  test("registers the docs-drift-guard built-in preset", () => {
    const definition = getPreset("docs-drift-guard");
    expect(definition).toBeDefined();
    expect(definition?.version).toBe(PRESET_VERSION);
    expect(definition?.outputModes).toEqual(["ticket", "pull_request"]);
    expect(definition?.defaultOutputMode).toBe("ticket");
    expect(definition?.run).toBeFunction();
    expect(definition?.validateOptions).toBeFunction();
    expect(definition?.checkPrerequisites).toBeFunction();
    expect(listPresetNames()).toContain("docs-drift-guard");
  });

  test("registers custom definitions and replaces by name", () => {
    const definition = {
      name: "nightly-test-audit",
      version: 1,
      summary: "future preset",
      outputModes: ["ticket" as const],
      defaultOutputMode: "ticket" as const,
    };
    registerPreset(definition);
    expect(getPreset("nightly-test-audit")).toBe(definition);
    // Adding a preset does not disturb existing entries (registry is generic).
    expect(getPreset("docs-drift-guard")).toBeDefined();
    expect(
      listPresets().every((a, index, all) => index === 0 || a.name >= all[index - 1]!.name),
    ).toBe(true);
    registerPreset({ ...definition, version: 2 });
    expect(getPreset("nightly-test-audit")?.version).toBe(2);
  });

  test("unknown presets resolve to undefined", () => {
    expect(getPreset("no-such-preset")).toBeUndefined();
  });

  describe("resolvePresetOutputMode", () => {
    const errors: string[] = [];
    const onError = (message: string) => errors.push(message);

    test("returns the preset default when omitted", () => {
      const definition = getPreset("docs-drift-guard")!;
      expect(resolvePresetOutputMode(definition, {}, onError)).toBe("ticket");
      expect(errors).toHaveLength(0);
    });

    test("accepts supported modes", () => {
      const definition = getPreset("docs-drift-guard")!;
      expect(resolvePresetOutputMode(definition, { output_mode: "pull_request" }, onError)).toBe(
        "pull_request",
      );
      expect(resolvePresetOutputMode(definition, { output_mode: "ticket" }, onError)).toBe(
        "ticket",
      );
    });

    test("rejects unsupported and malformed modes with actionable errors", () => {
      const definition = getPreset("docs-drift-guard")!;
      expect(resolvePresetOutputMode(definition, { output_mode: "pr" }, onError)).toBeNull();
      expect(errors[0]).toContain('output_mode "pr" is not supported by preset "docs-drift-guard"');
      expect(errors[0]).toContain("ticket, pull_request");
      expect(resolvePresetOutputMode(definition, { output_mode: 42 }, onError)).toBeNull();
      expect(resolvePresetOutputMode(definition, { output_mode: "  " }, onError)).toBeNull();
    });
  });
});
