import { describe, expect, test } from "bun:test";
import type { DetectedSandboxProvider } from "@devintern/agent-harness";
import { buildSandboxDoctorReport } from "../src/lib/agent/sandbox";

function detected(
  name: string,
  opts: {
    available?: boolean;
    reason?: string;
    version?: string;
    priority?: number;
    harnesses?: string[];
    canNestInSandbox?: boolean;
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
      ...(opts.canNestInSandbox !== undefined ? { canNestInSandbox: opts.canNestInSandbox } : {}),
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

  test("active enclosing sandbox: reports inherited confinement for an explicit provider", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { priority: 30 }), detected("srt", { priority: 20 })],
      "srt",
      ".devintern-code/.env",
      "claude-code",
      "linux",
      { activeSandbox: "nono" },
    );
    const text = report.lines.join("\n");
    expect(report.nextRunFails).toBe(false);
    expect(text).toContain("already inside the nono sandbox");
    expect(text).not.toContain("agent wrapped with");
  });

  test("active enclosing sandbox: auto reports inherited confinement", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { priority: 30 })],
      "auto",
      "default",
      "claude-code",
      "linux",
      { activeSandbox: "nono" },
    );
    expect(report.nextRunFails).toBe(false);
    expect(report.lines.join("\n")).toContain("already inside the nono sandbox");
  });

  test("active enclosing sandbox still fails on an unknown provider", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { priority: 30 })],
      "chroot",
      "environment",
      "claude-code",
      "linux",
      { activeSandbox: "nono" },
    );
    expect(report.nextRunFails).toBe(true);
    expect(report.lines.join("\n")).toContain('unknown provider "chroot"');
  });

  test("active enclosing sandbox: unavailable explicit provider still fails (matches resolver)", () => {
    const report = buildSandboxDoctorReport(
      [detected("srt", { available: false, reason: "srt not found on PATH" })],
      "srt",
      ".devintern-code/.env",
      "claude-code",
      "linux",
      { activeSandbox: "nono" },
    );
    const text = report.lines.join("\n");
    expect(report.nextRunFails).toBe(true);
    expect(text).toContain("❌ fails");
    expect(text).toContain("srt not found on PATH");
    expect(text).not.toContain("already inside the nono sandbox");
  });

  test("active enclosing sandbox: harness-incompatible explicit provider still fails", () => {
    const report = buildSandboxDoctorReport(
      [detected("smolvm", { harnesses: ["claude-code", "codex", "pi"] })],
      "smolvm",
      "environment",
      "goose",
      "linux",
      { activeSandbox: "nono" },
    );
    const text = report.lines.join("\n");
    expect(report.nextRunFails).toBe(true);
    expect(text).toContain('does not support the configured "goose" harness');
    expect(text).not.toContain("already inside the nono sandbox");
  });

  test("active enclosing sandbox: nesting-capable provider is wrapped, not inherited", () => {
    const report = buildSandboxDoctorReport(
      [detected("docker", { canNestInSandbox: true, priority: 0 })],
      "docker",
      ".devintern-code/.env",
      "claude-code",
      "linux",
      { activeSandbox: "nono" },
    );
    const text = report.lines.join("\n");
    expect(report.nextRunFails).toBe(false);
    expect(text).toContain("agent wrapped with docker (test)");
    expect(text).not.toContain("already inside the nono sandbox");
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

  test("renders the harness CLI preflight table with OK/FAIL and the fix", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { priority: 30 })],
      "nono",
      ".devintern-code/.env",
      "opencode",
      "linux",
      {
        preflight: {
          provider: "nono",
          entries: [
            { name: "opencode", path: "/home/daniil/.opencode/bin/opencode", ok: true },
            {
              name: "grok",
              path: "/home/daniil/.local/bin/grok",
              ok: false,
              reason: "mise: Permission denied",
              suggestion:
                "set GROK_CLI_PATH=/path/to/grok (the real executable, not the mise shim)",
            },
          ],
        },
      },
    );
    const text = report.lines.join("\n");
    expect(text).toContain("Harness CLI preflight (nono)");
    expect(text).toContain("opencode  /home/daniil/.opencode/bin/opencode");
    expect(text).toContain("OK");
    expect(text).toContain("grok      /home/daniil/.local/bin/grok");
    expect(text).toContain("FAIL — mise: Permission denied");
    expect(text).toContain("→ set GROK_CLI_PATH=/path/to/grok");
  });

  test("a failing primary preflight makes the next run fail", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { priority: 30 })],
      "nono",
      "environment",
      "grok",
      "linux",
      {
        preflight: {
          provider: "nono",
          entries: [
            {
              name: "grok",
              path: "/home/daniil/.local/bin/grok",
              ok: false,
              reason: "mise: Permission denied",
            },
          ],
        },
      },
    );
    expect(report.nextRunFails).toBe(true);
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

  test("nono pack status per chain entry is surfaced", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { priority: 30 })],
      "nono",
      ".devintern-code/.env",
      "grok",
      "linux",
      {
        packStatuses: [
          {
            harnessName: "grok",
            packBacked: false,
            note: 'nono has no pack profile for "grok"; using linux-host-compat + explicit grants (state: ~/.grok).',
          },
          { harnessName: "opencode", packBacked: true, profile: "opencode" },
        ],
      },
    );
    const text = report.lines.join("\n");
    expect(text).toContain("nono pack profiles (per harness chain entry):");
    expect(text).toContain('nono has no pack profile for "grok"');
    expect(text).toContain('pack profile "opencode"');
  });

  test("the pack section is hidden when nono is not installed", () => {
    const report = buildSandboxDoctorReport(
      [detected("nono", { available: false, reason: "nono not found on PATH" })],
      "none",
      "default",
      "grok",
      "linux",
      {
        packStatuses: [
          { harnessName: "grok", packBacked: false, note: 'nono has no pack profile for "grok".' },
        ],
      },
    );
    expect(report.lines.join("\n")).not.toContain("nono pack profiles");
  });
});
