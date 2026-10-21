import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBugReporter } from "../src/lib/report/api";
import { ReportSubmitError } from "../src/lib/report/client";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "report-api-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function reporterWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  overrides: { accessToken?: string; signedIn?: boolean; contactEmail?: string } = {},
) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return {
    reporter: createBugReporter({
      cwd: workdir,
      configDir: workdir,
      cliVersion: "9.9.9",
      endpoint: "https://reports.example.test/api/reports",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      fetchImpl,
      ...overrides,
    }),
    requests,
  };
}

describe("bug reporter", () => {
  test("prepares a redacted payload with a stable id and fingerprint", async () => {
    const { reporter } = reporterWith(() => new Response("{}"));
    const prepared = await reporter.prepare({
      title: "Worker crashes ghp_abcdefghijklmnopqrstuvwxyz",
      description: `It failed at ${workdir}/src/index.ts for PROJ-123`,
      taskKey: "PROJ-123",
      diagnostics: false,
      contactEmail: "user@example.com",
    });

    expect(prepared.payload.reportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.payload.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(prepared.payload.title).not.toContain("ghp_");
    expect(prepared.payload.description).not.toContain(workdir);
    expect(prepared.payload.description).not.toContain("PROJ-123");
    expect(prepared.payload.contact?.email).toBe("user@example.com");
    expect(prepared.payload.fingerprint.startsWith("sha256:")).toBe(true);
    expect(prepared.bytes).toBeLessThan(240 * 1024);
  });

  test("bounds an oversized description", async () => {
    const { reporter } = reporterWith(() => new Response("{}"));
    const prepared = await reporter.prepare({
      title: "Large description",
      description: "x".repeat(100_000),
      diagnostics: false,
    });
    expect(prepared.payload.description.length).toBeLessThanOrEqual(20_001);
  });

  test("posts with a bearer token and returns the server receipt", async () => {
    const { reporter, requests } = reporterWith(
      () =>
        new Response(JSON.stringify({ id: "report-1", receipt: "r-1", url: "https://x/y" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      { accessToken: "token-123", signedIn: true },
    );
    const result = await reporter.submit({
      title: "Signed-in report",
      description: "Details",
      diagnostics: false,
    });

    expect(result).toEqual({ id: "report-1", receipt: "r-1", url: "https://x/y" });
    expect(requests).toHaveLength(1);
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-123");
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      contact?: { signedIn?: boolean };
    };
    expect(body.contact?.signedIn).toBe(true);
  });

  test("maps a server rejection to a status-bearing error", async () => {
    const { reporter } = reporterWith(
      () =>
        new Response(JSON.stringify({ error: "too many reports" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const prepared = await reporter.prepare({
      title: "Rejected",
      description: "Details",
      diagnostics: false,
    });
    const error = await reporter.submitPrepared(prepared).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReportSubmitError);
    expect((error as ReportSubmitError).status).toBe(429);
    expect((error as ReportSubmitError).message).toContain("too many reports");
  });

  test("rejects an empty title", async () => {
    const { reporter } = reporterWith(() => new Response("{}"));
    await expect(
      reporter.prepare({ title: "   ", description: "Details", diagnostics: false }),
    ).rejects.toThrow("non-empty title");
  });
});
