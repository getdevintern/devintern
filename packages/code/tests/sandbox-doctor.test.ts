import { describe, expect, test } from "bun:test";
import type { DetectedSandboxProvider } from "@devintern/agent-harness";
import { buildSandboxDoctorReport } from "../src/lib/sandbox";

function detected(
  name: string,
  opts: {
    available?: boolean;
    reason?: string;
    version?: string;
    priority?: number;
    harnesses?: string[];
  } = {},
): DetectedSandboxProvider {
  return {
    provider: {
      name,
      displayName: `${name} (test)`,
      priority: opts.priority ?? 10,
      docsUrl: `https://example.com/${name}`,
      detect: async () => ({ available: true }),
      ...(opts.harnesses ? { supportsHarness: (h: string) => opts.harnesses!.includes(h) } : {}),
      wrapCommand: () => ({ path: name, args: [] }),
    },
    detection: {
      available: opts.available ?? true,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.version ? { version: opts.version } : {}),
    },
  };
}

describe("buildSandboxDoctorReport", () => {
  test("sandboxing off: says so and suggests the best installed provider", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { priority: 30 }), detected("srt", { priority: 20 })],
      "none",
      "default",
      "claude-code",
      "linux",
    );
    const text = report.lines.join("\n");
    expect(report.nextRunFails).toBe(false);
    expect(text).toContain("agents run unsandboxed (sandboxing is off)");
    expect(text).toContain("nono is installed and ready");
    expect(text).toContain("AGENT_SANDBOX=nono");
  });

  test("auto with nothing usable: warns about unsandboxed fallback", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { available: false, reason: "nono not found on PATH" })],
      "auto",
      ".devintern-code/.env",
      "claude-code",
      "linux",
    );
    expect(report.nextRunFails).toBe(false);
    expect(report.lines.join("\n")).toContain("proceeds unsandboxed with a warning");
  });

  test("explicit unavailable provider: next run fails with the detection reason", () => {
    const report = buildSandboxDoctorReport(
      [detected("srt", { available: false, reason: "srt not found on PATH. Install: npm i -g" })],
      "srt",
      ".devintern-code/.env",
      "claude-code",
      "linux",
    );
    const text = report.lines.join("\n");
    expect(report.nextRunFails).toBe(true);
    expect(text).toContain("❌ fails");
    expect(text).toContain("srt not found on PATH");
  });

  test("explicit provider that does not support the harness: next run fails", () => {
    const report = buildSandboxDoctorReport(
      [detected("smolvm", { harnesses: ["claude-code", "codex", "pi"] })],
      "smolvm",
      "environment",
      "goose",
      "linux",
    );
    const text = report.lines.join("\n");
    expect(report.nextRunFails).toBe(true);
    expect(text).toContain('does not support the configured "goose" harness');
  });

  test("unknown provider name: next run fails and lists valid values", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono")],
      "chroot",
      "environment",
      "claude-code",
      "linux",
    );
    expect(report.nextRunFails).toBe(true);
    expect(report.lines.join("\n")).toContain('unknown provider "chroot"');
  });

  test("version hints after an em-dash separator move to their own warning line", () => {
    const report = buildSandboxDoctorReport(
      [
        detected("nono", {
          version:
            'nono 0.69.0 — for claude-code runs, first install the Claude pack: "nono pull nolabs-ai/claude"',
        }),
      ],
      "none",
      "default",
      "claude-code",
      "linux",
    );
    const text = report.lines.join("\n");
    expect(text).toContain("✅ available (nono 0.69.0)");
    expect(text).toContain("⚠ for claude-code runs, first install the Claude pack");
  });

  test("per-provider setup notes are platform aware", () => {
    const linuxText = buildSandboxDoctorReport(
      [detected("docker"), detected("smolvm")],
      "none",
      "default",
      "claude-code",
      "linux",
    ).lines.join("\n");
    expect(linuxText).toContain("setup: one-time: sbx policy init balanced");
    expect(linuxText).not.toContain("after sbx login");
    expect(linuxText).toContain("needs KVM (/dev/kvm)");

    const macText = buildSandboxDoctorReport(
      [detected("docker"), detected("smolvm")],
      "none",
      "default",
      "claude-code",
      "darwin",
    ).lines.join("\n");
    expect(macText).toContain("sbx policy init balanced (after sbx login)");
    expect(macText).not.toContain("needs KVM");
  });
});
