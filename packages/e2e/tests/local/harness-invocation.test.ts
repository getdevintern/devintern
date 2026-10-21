import { expect, test } from "bun:test";
import {
  HARNESS_PROBE_PROMPT,
  detectInvocationRejection,
  discoverHarnesses,
  probeHarnessInvocation,
} from "../../helpers/harness-invocation";

const harnesses = discoverHarnesses();

test("distinguishes parser rejections from authentication failures and timeouts", () => {
  const result = (overrides: {
    exitCode: number | null;
    timedOut?: boolean;
    stdout?: string;
    stderr?: string;
  }) => ({
    exitCode: overrides.exitCode,
    timedOut: overrides.timedOut ?? false,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
  });

  expect(
    detectInvocationRejection(result({ exitCode: 1, stderr: "error: unknown option '--bogus'" })),
  ).toContain("unknown option");
  expect(
    detectInvocationRejection(
      result({ exitCode: 2, stderr: "error: unexpected argument '--bogus' found" }),
    ),
  ).toContain("unexpected argument");
  expect(
    detectInvocationRejection(result({ exitCode: 1, stderr: "Error: Unknown option: --bogus" })),
  ).toContain("unknown option");
  expect(
    detectInvocationRejection(
      result({
        exitCode: 1,
        stdout: "DESCRIPTION\n  Run the agent\nUSAGE\n  agent run\nFLAGS\n  --model string",
      }),
    ),
  ).toContain("usage/help");
  expect(
    detectInvocationRejection(result({ exitCode: 1, stderr: "Not logged in · Please run /login" })),
  ).toBeUndefined();
  expect(
    detectInvocationRejection(
      result({ exitCode: null, timedOut: true, stdout: "starting the agent..." }),
    ),
  ).toBeUndefined();
  expect(
    detectInvocationRejection(
      result({
        exitCode: 0,
        stdout: "The model discussed an unknown option but the run succeeded",
      }),
    ),
  ).toBeUndefined();
});

for (const entry of harnesses) {
  test.concurrent.skipIf(!entry.installed)(
    `${entry.harness.displayName} (${entry.harness.name}) accepts the generated invocation`,
    async () => {
      const probe = await probeHarnessInvocation(entry);
      const rejection = detectInvocationRejection(probe);
      if (rejection) {
        throw new Error(
          [
            `${rejection} for ${entry.harness.name} (${entry.path})`,
            `exit=${probe.exitCode ?? "timeout"} timedOut=${probe.timedOut} duration=${probe.durationMs}ms`,
            `args=${JSON.stringify(probe.args)}`,
            `stdout:\n${probe.stdout.slice(-4000)}`,
            `stderr:\n${probe.stderr.slice(-4000)}`,
          ].join("\n"),
        );
      }
      // Sanity-check that this probe really exercised prompt delivery rather
      // than a help/version path with no task input.
      expect(probe.args).toContain(HARNESS_PROBE_PROMPT);
    },
    30_000,
  );
}
