import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const existingCeilings = process.env.GIT_CEILING_DIRECTORIES;
const gitCeilingDirectories = [resolve(tmpdir()), existingCeilings]
  .filter((value): value is string => Boolean(value))
  .join(delimiter);

// Give every bun test child a safe WEBHOOK_QUEUE_DB in its process-start
// environment. The per-file guard (tests/setup/guard-queue-db.ts) re-pins it
// for in-process code, but Bun children spawned WITHOUT an explicit env option
// inherit the environment captured when the test process started, so the pin
// has to exist before that too — otherwise such children could fall back to a
// developer's real .devintern-code/queue.db if their cwd sits inside a
// configured project tree.
const queueDbTempDir = mkdtempSync(join(tmpdir(), "devintern-test-state-"));
process.on("exit", () => {
  try {
    rmSync(queueDbTempDir, { recursive: true, force: true });
  } catch {
    // Best effort: leftover temp state under the OS tmpdir is harmless.
  }
});

const child = Bun.spawn(["bun", "test", "--timeout=30000", ...process.argv.slice(2)], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    GIT_CEILING_DIRECTORIES: gitCeilingDirectories,
    WEBHOOK_QUEUE_DB: join(queueDbTempDir, "queue.db"),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
