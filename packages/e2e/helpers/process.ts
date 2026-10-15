export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function command(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeout = 120_000,
): Promise<CommandResult> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeout);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`Command timed out: ${args[0]}`);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkedCommand(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const result = await command(args, cwd, env);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${args[0]}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}
