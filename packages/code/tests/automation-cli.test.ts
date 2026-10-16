import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadWorkspaceConfig } from "../src/lib/workspace/config";

setDefaultTimeout(30_000);

const CLI_PATH = join(__dirname, "..", "src", "index.ts");
const tempDirs: string[] = [];

function makeWorkspace(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "automation-cli-"));
  tempDirs.push(dir);
  const configPath = join(dir, "workspace.toml");
  writeFileSync(
    configPath,
    `[defaults]
tracker = "jira"
`,
  );
  return { dir, configPath };
}

async function runCli(
  args: string[],
  workspaceDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI_PATH, ...args],
    env: {
      ...process.env,
      DEVINTERN_WORKSPACE_DIR: workspaceDir,
      DEVINTERN_NO_UPDATE: "1",
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      SENTRY_DISABLED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("devintern automations CLI", () => {
  test("list shows the bundled packs", async () => {
    const { dir } = makeWorkspace();
    const { stdout, exitCode } = await runCli(["automations", "list"], dir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("dependency-health");
    expect(stdout).toContain("flaky-test-triage");
  });

  test("add installs a named pack into workspace.toml", async () => {
    const { dir, configPath } = makeWorkspace();
    const { stdout, exitCode } = await runCli(
      ["automations", "add", "dependency-health", "--workspace", configPath],
      dir,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Installed "dependency-health"');

    const config = loadWorkspaceConfig(configPath);
    expect(config.automations.map((entry) => entry.id)).toEqual(["dependency-health"]);
    expect(config.automations[0]?.prompt).toContain("\n");
  });

  test("add fails clearly for an unknown pack", async () => {
    const { dir, configPath } = makeWorkspace();
    const { stderr, exitCode } = await runCli(
      ["automations", "add", "does-not-exist", "--workspace", configPath],
      dir,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown automation pack");
  });

  test("help lists the subcommands", async () => {
    const { dir } = makeWorkspace();
    const { stdout, exitCode } = await runCli(["automations", "--help"], dir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("add <pack>");
  });
});
