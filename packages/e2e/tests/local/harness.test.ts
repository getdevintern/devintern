import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { checkedCommand, command } from "../../helpers/process";

const fixture = resolve(import.meta.dir, "../../fixtures/simple-project");
const agentPath = resolve(import.meta.dir, "../../helpers/fake-agent.ts");

test("the deterministic agent changes exactly the fixture greeting and verifies it", async () => {
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-local-"));
  const cwd = join(root, "repo");
  try {
    cpSync(fixture, cwd, { recursive: true });
    const env = isolatedEnvironment(root);
    const output = await checkedCommand(
      [process.execPath, agentPath, "-p", "fixture task"],
      cwd,
      env,
    );
    expect(readFileSync(join(cwd, "src/greeting.ts"), "utf8")).toBe(
      'export const greeting = "Hello, world!";\n',
    );
    expect(output).toContain("<!-- devintern:summary:start -->");
    expect(output).toContain("Ran bun test successfully");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.WEBHOOK_QUEUE_DB).toBe(join(root, "queue.db"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the deterministic agent refuses to edit until seeded description and comment markers reach its input", async () => {
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-local-"));
  const cwd = join(root, "repo");
  try {
    cpSync(fixture, cwd, { recursive: true });
    const env = isolatedEnvironment(root);
    env.E2E_EXPECT_DESCRIPTION_MARKER = "E2E_DESCRIPTION_MARKER_test";
    env.E2E_EXPECT_COMMENT_MARKER = "E2E_COMMENT_MARKER_test";
    const original = readFileSync(join(cwd, "src/greeting.ts"), "utf8");

    const missing = await command(
      [process.execPath, agentPath, "-p", "only the description marker"],
      cwd,
      env,
    );
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout + missing.stderr).toContain("marker");
    expect(readFileSync(join(cwd, "src/greeting.ts"), "utf8")).toBe(original);

    const output = await checkedCommand(
      [process.execPath, agentPath, "-p", "E2E_DESCRIPTION_MARKER_test E2E_COMMENT_MARKER_test"],
      cwd,
      env,
    );
    expect(readFileSync(join(cwd, "src/greeting.ts"), "utf8")).toBe(
      'export const greeting = "Hello, world!";\n',
    );
    expect(output).toContain("<!-- devintern:summary:start -->");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
