import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Write an executable agent stub that records the argv DevIntern passed to the
 * harness CLI, then hands the same argv to a delegate agent (normally the
 * deterministic `fake-agent.ts`) and exits with its status.
 *
 * Each spawn appends one JSON array (argv without the runtime and script
 * path) to `logPath`, so a test can assert the exact turn-limit flag of every
 * harness invocation in a run, including the git-hook repair turn.
 *
 * @param path - Where to write the stub (it becomes the agent path)
 * @param delegatePath - Agent script the stub runs with the original argv
 * @param logPath - JSON-lines file the stub appends each argv to
 */
export function writeArgvRecorder(path: string, delegatePath: string, logPath: string): void {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bun",
      'import { appendFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");`,
      `const child = Bun.spawn([process.execPath, ${JSON.stringify(delegatePath)}, ...args], {`,
      '  stdin: "inherit",',
      '  stdout: "inherit",',
      '  stderr: "inherit",',
      "});",
      "process.exit(await child.exited);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
}

/** Every argv the recorder captured, in spawn order. */
export function recordedArgv(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/**
 * Values of every `--max-turns` flag in one argv (claude-code's turn-limit
 * argument). Returning all occurrences catches a duplicated flag.
 */
export function maxTurnsValues(argv: string[]): string[] {
  const values: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === "--max-turns") values.push(argv[index + 1] ?? "");
    else if (arg.startsWith("--max-turns=")) values.push(arg.slice("--max-turns=".length));
  });
  return values;
}
