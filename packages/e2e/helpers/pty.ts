/**
 * A command on a Bun pseudo-terminal (`Bun.spawn({ terminal })`, Bun >= 1.3.5;
 * no `expect` or `script` binary needed).
 *
 * Keystrokes are written to the PTY as raw bytes, so `\x04` (Ctrl+D) and
 * `\x03` (Ctrl+C) reach a raw-mode readline exactly as they would from a real
 * keyboard. The onboarding golden path drives the wizard inside a container
 * through `docker exec -it` on one of these terminals.
 */
import { stripAnsi } from "./worker-init";

export const ptyAvailable = typeof Bun.Terminal === "function" && process.platform !== "win32";

export class PtySession {
  private raw = "";
  private readonly decoder = new TextDecoder();
  private readonly child: Bun.Subprocess;

  constructor(
    argv: string[],
    options: { cwd?: string; env: Record<string, string>; cols?: number; rows?: number },
  ) {
    this.child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      terminal: {
        cols: options.cols ?? 200,
        rows: options.rows ?? 50,
        data: (_terminal, data) => {
          this.raw += this.decoder.decode(data, { stream: true });
        },
      },
    });
  }

  /** Terminal bytes so far, before ANSI stripping. */
  get rawOutput(): string {
    return this.raw;
  }

  /** Screen output so far with ANSI sequences and carriage returns removed. */
  get output(): string {
    return stripAnsi(this.raw);
  }

  /** Exit code, or null while the process runs. */
  get exitCode(): number | null {
    return this.child.exitCode;
  }

  write(keys: string): void {
    this.child.terminal!.write(keys);
  }

  /** Wait for exit until `deadline` (epoch ms), then let the PTY drain its last lines. */
  async waitForExit(deadline: number, label = "the command"): Promise<number> {
    const exitCode = await Promise.race([
      this.child.exited,
      Bun.sleep(Math.max(deadline - Date.now(), 1)).then(() => {
        throw new Error(`${label} did not exit.\n${this.output}`);
      }),
    ]);
    await Bun.sleep(100);
    return exitCode;
  }

  /** Kill the process if it still runs and close the terminal. */
  close(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    this.child.terminal?.close();
  }
}
