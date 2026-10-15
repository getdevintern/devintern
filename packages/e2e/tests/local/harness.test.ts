import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { checkedCommand } from "../../helpers/process";

test("the deterministic agent changes exactly the fixture greeting and verifies it", async () => {
  const root = mkdtempSync(join(tmpdir(), "devintern-e2e-local-"));
  const cwd = join(root, "repo");
  try {
    cpSync(resolve(import.meta.dir, "../../fixtures/simple-project"), cwd, { recursive: true });
    const env = isolatedEnvironment(root);
    const output = await checkedCommand(
      [
        process.execPath,
        resolve(import.meta.dir, "../../helpers/fake-agent.ts"),
        "-p",
        "fixture task",
      ],
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
