import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  defaultCatalogDir,
  listCatalogPacks,
  loadCatalogPack,
  validateCatalog,
} from "../src/lib/automation/catalog";

const tempDirs: string[] = [];

function makeCatalog(packOverrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
  tempDirs.push(dir);
  const packDir = join(dir, "packs", "alpha");
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "prompt.md"), "Do the thing.\n");
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({
      id: "alpha",
      name: "Alpha",
      description: "First pack",
      schedule: { cron: "0 1 * * *" },
      openPr: true,
      prompt: "prompt.md",
      ...packOverrides,
    }),
  );
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ version: 1, packs: ["alpha"] }));
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("bundled catalog", () => {
  test("is valid and ships at least two packs", () => {
    const { packs, issues } = validateCatalog(defaultCatalogDir());
    expect(issues).toEqual([]);
    expect(packs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(packs.map((pack) => pack.id)).size).toBe(packs.length);
  });

  test("loads a known pack with its prompt body", () => {
    const pack = loadCatalogPack("dependency-health");
    expect(pack.id).toBe("dependency-health");
    expect(pack.schedule.cron).toBeTruthy();
    expect(pack.prompt.length).toBeGreaterThan(0);
    expect(pack.openPr).toBe(true);
  });

  test("rejects an unknown pack id with a hint", () => {
    expect(() => loadCatalogPack("does-not-exist")).toThrow(/automations list/);
  });
});

describe("validateCatalog", () => {
  test("accepts a well-formed pack", () => {
    const { packs, issues } = validateCatalog(makeCatalog());
    expect(issues).toEqual([]);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.prompt).toContain("Do the thing");
  });

  test("reports duplicate index ids as errors", () => {
    const dir = makeCatalog();
    writeFileSync(join(dir, "catalog.json"), JSON.stringify({ packs: ["alpha", "alpha"] }));
    const { issues } = validateCatalog(dir);
    expect(issues.some((issue) => issue.message.includes("Duplicate pack id"))).toBe(true);
  });

  test("reports a missing prompt file as broken", () => {
    const dir = makeCatalog({ prompt: "missing.md" });
    const { packs, issues } = validateCatalog(dir);
    expect(packs).toHaveLength(0);
    expect(
      issues.some((issue) => issue.level === "error" && issue.message.includes("missing.md")),
    ).toBe(true);
  });

  test("reports an index entry with no directory as broken", () => {
    const dir = makeCatalog();
    rmSync(join(dir, "packs", "alpha"), { recursive: true, force: true });
    const { issues } = validateCatalog(dir);
    expect(issues.some((issue) => issue.message.includes("directory is missing"))).toBe(true);
  });

  test("reports an unlisted pack directory as orphaned", () => {
    const dir = makeCatalog();
    const orphan = join(dir, "packs", "orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "pack.json"), JSON.stringify({ id: "orphan" }));
    const { issues } = validateCatalog(dir);
    const orphanIssue = issues.find((issue) => issue.packId === "orphan");
    expect(orphanIssue?.level).toBe("warn");
    expect(orphanIssue?.message).toContain("orphaned");
  });

  test("rejects an invalid schedule", () => {
    const dir = makeCatalog({ schedule: { cron: "not a cron" } });
    const { issues } = validateCatalog(dir);
    expect(issues.some((issue) => issue.level === "error" && issue.message.includes("cron"))).toBe(
      true,
    );
  });

  test("fails cleanly when the index is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-empty-"));
    tempDirs.push(dir);
    const { packs, issues } = validateCatalog(dir);
    expect(packs).toEqual([]);
    expect(issues[0]?.level).toBe("error");
  });

  test("listCatalogPacks returns summaries and issues", () => {
    const { packs, issues } = listCatalogPacks(defaultCatalogDir());
    expect(issues).toEqual([]);
    expect(packs.every((pack) => pack.id && pack.name && pack.description)).toBe(true);
  });
});
