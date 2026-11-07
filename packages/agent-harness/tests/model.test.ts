import { afterEach, describe, expect, test } from "bun:test";

import {
  listModelAliases,
  registerModelAlias,
  resetModelAliases,
  resolveModelAlias,
} from "../src/model.js";

afterEach(() => {
  resetModelAliases();
});

describe("resolveModelAlias", () => {
  test("resolves a family to the latest concrete model for the harness", () => {
    const result = resolveModelAlias({ harness: "claude-code", model: "astra" });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.alias).toBe("astra");
      expect(result.model).toBe("claude-opus-4-6");
    }
  });

  test("resolves a family for a non-default harness", () => {
    const result = resolveModelAlias({ harness: "codex", model: "gpt" });
    expect(result).toEqual({ kind: "resolved", alias: "gpt", model: "gpt-5.2" });
  });

  test("matches aliases case-insensitively", () => {
    const result = resolveModelAlias({ harness: "claude-code", model: "ASTRA" });
    expect(result.kind).toBe("resolved");
  });

  test("passes exact model identifiers through untouched", () => {
    const result = resolveModelAlias({
      harness: "claude-code",
      model: "claude-opus-4-5-20260101",
    });
    expect(result).toEqual({ kind: "passthrough", model: "claude-opus-4-5-20260101" });
  });

  test("reports a known family used with an incompatible harness", () => {
    const result = resolveModelAlias({ harness: "goose", model: "astra" });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain('not available for harness "goose"');
      expect(result.reason).toContain("claude-code");
    }
  });

  test("reports a family with no models available for the harness", () => {
    registerModelAlias({ alias: "empty", harness: "claude-code", models: [] });
    const result = resolveModelAlias({ harness: "claude-code", model: "empty" });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("no available models");
    }
  });

  test("repointing a family at newer ids changes what resolves", () => {
    registerModelAlias({ alias: "astra", harness: "claude-code", models: ["claude-opus-5-0"] });
    const result = resolveModelAlias({ harness: "claude-code", model: "astra" });
    expect(result).toEqual({ kind: "resolved", alias: "astra", model: "claude-opus-5-0" });
  });

  test("wildcard families apply to any harness", () => {
    registerModelAlias({ alias: "anywhere", harness: "*", models: ["universal-1"] });
    const result = resolveModelAlias({ harness: "goose", model: "anywhere" });
    expect(result).toEqual({ kind: "resolved", alias: "anywhere", model: "universal-1" });
  });

  test("a harness-specific family wins over a wildcard registered first", () => {
    registerModelAlias({ alias: "fam", harness: "*", models: ["universal"] });
    registerModelAlias({ alias: "fam", harness: "claude-code", models: ["specific"] });
    expect(resolveModelAlias({ harness: "claude-code", model: "fam" })).toEqual({
      kind: "resolved",
      alias: "fam",
      model: "specific",
    });
  });

  test("a harness-specific family wins over a wildcard registered later", () => {
    registerModelAlias({ alias: "fam", harness: "claude-code", models: ["specific"] });
    registerModelAlias({ alias: "fam", harness: "*", models: ["universal"] });
    expect(resolveModelAlias({ harness: "claude-code", model: "fam" })).toEqual({
      kind: "resolved",
      alias: "fam",
      model: "specific",
    });
  });

  test("an empty harness-specific family does not mask a usable wildcard", () => {
    registerModelAlias({ alias: "fam", harness: "*", models: ["universal"] });
    registerModelAlias({ alias: "fam", harness: "claude-code", models: [] });
    expect(resolveModelAlias({ harness: "claude-code", model: "fam" })).toEqual({
      kind: "resolved",
      alias: "fam",
      model: "universal",
    });
  });
});

describe("listModelAliases", () => {
  test("lists all definitions", () => {
    const all = listModelAliases();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((entry) => entry.alias === "astra" && entry.harness === "claude-code")).toBe(
      true,
    );
  });

  test("filters to one harness", () => {
    const claude = listModelAliases("claude-code");
    expect(claude.every((entry) => entry.harness === "claude-code")).toBe(true);
    expect(claude.map((entry) => entry.alias)).toContain("astra");
  });
});
