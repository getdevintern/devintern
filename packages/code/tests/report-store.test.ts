import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findSpoolEntry,
  listSpoolEntries,
  markSpoolError,
  markSpoolSubmitted,
  reserveAutoReport,
  saveSpoolEntry,
} from "../src/lib/report/store";
import type { BugReportPayload } from "../src/lib/report/types";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "report-store-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function payload(id: string): BugReportPayload {
  return {
    schema: 1,
    reportId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    source: "cli",
    title: "Example",
    description: "Body",
    environment: {
      cliVersion: "1.0.0",
      installKind: "local",
      runtime: { node: "v22.0.0", os: "linux", arch: "x64", ci: false },
      signedIn: false,
      telemetry: true,
    },
    fingerprint: "sha256:abc",
    userAgent: "devintern/1.0.0",
  };
}

describe("report spool", () => {
  test("saves, finds, lists, and marks a report submitted", () => {
    const path = saveSpoolEntry(workdir, payload("11111111-1111-1111-1111-111111111111"));
    expect(path.endsWith(".json")).toBe(true);
    expect(findSpoolEntry(workdir, "11111111")?.status).toBe("pending");
    expect(listSpoolEntries(workdir)).toHaveLength(1);

    markSpoolSubmitted(workdir, "11111111-1111-1111-1111-111111111111", {
      id: "r1",
      receipt: "receipt-1",
      url: "https://devintern.com/account/reports",
    });
    const entry = findSpoolEntry(workdir, "11111111");
    expect(entry?.status).toBe("submitted");
    expect(entry?.receipt).toBe("receipt-1");
    expect(entry?.url).toContain("/account/reports");
  });

  test("attaches the last submission error without duplicating the report", () => {
    saveSpoolEntry(workdir, payload("22222222-2222-2222-2222-222222222222"));
    markSpoolError(workdir, "22222222-2222-2222-2222-222222222222", "offline");
    const entries = listSpoolEntries(workdir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.error).toBe("offline");
  });

  test("deduplicates and caps automatic reports", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(reserveAutoReport(workdir, "sha256:a", { now })).toBe(true);
    expect(reserveAutoReport(workdir, "sha256:a", { now })).toBe(false);
    for (let i = 0; i < 4; i++) {
      expect(reserveAutoReport(workdir, `sha256:${i}`, { now })).toBe(true);
    }
    expect(reserveAutoReport(workdir, "sha256:overflow", { now })).toBe(false);
  });
});
