/**
 * Helpers for the nono sandbox end-to-end suite.
 *
 * The suite drives the built CLI with a deterministic shell agent wrapped in
 * nono, so it can assert the real Landlock/Seatbelt boundary: writes inside
 * the task workspace, temp dir and output dir succeed, while writes elsewhere
 * under `$HOME` are denied. No AI account or model call is involved.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { isolatedEnvironment } from "./environment";
import { cliPath } from "./fixture-workspace";
import { checkedCommand, command } from "./process";

/** Name of the probe agent dropped into the isolated home. */
export const SANDBOX_AGENT_NAME = "sandbox-probe.sh";

/**
 * Seeded secret the probe reads. The v1 sandbox policy keeps reads open
 * ("reads stay open"), so this must stay readable while writes stay confined.
 */
export const SANDBOX_SECRET = "readable-outside-write-scope";

/**
 * Resolve the nono binary, or `undefined` when unavailable on this platform.
 *
 * @returns Absolute path to nono, if installed.
 */
export function nonoPath(): string | undefined {
  if (process.platform === "win32") return undefined;
  return Bun.which("nono") ?? undefined;
}

/**
 * Git-ignored scratch directory inside the checkout.
 *
 * Used when the usual system locations are unavailable. An enclosing kernel
 * sandbox (for example a nono-wrapped DevIntern worker that runs this suite
 * from its pre-push hook) commonly grants write access only to the checkout,
 * and denies `/var/tmp` even though `access()` reports it writable. The
 * checkout itself is still outside the OS temp dir, so it satisfies the home
 * constraint below, and `node_modules/.cache` keeps the fixture out of tracked
 * files.
 *
 * @returns Absolute path to the package's scratch directory.
 */
function checkoutScratchBase(): string {
  const base = join(import.meta.dir, "..", "node_modules", ".cache", "devintern-e2e");
  mkdirSync(base, { recursive: true });
  return base;
}

/**
 * Base directories for the isolated home, most preferred first.
 *
 * The home must live outside the OS temp dir. nono's generated Linux profile
 * extends `linux-host-compat`, which grants a broad read on `/tmp`; when HOME
 * is nested under that grant, nono refuses to start because its per-user deny
 * rules (credentials, shell history) cannot be enforced beneath an allowed
 * parent. A real user home is normally outside `/tmp`, so the fixture mirrors
 * that instead of weakening the product policy.
 *
 * @returns Candidate bases, excluding the OS temp dir itself.
 */
function sandboxHomeBases(): string[] {
  const candidates = process.platform === "linux" ? ["/var/tmp"] : [];
  try {
    candidates.push(checkoutScratchBase());
  } catch {
    // Read-only checkout: fall through to the OS temp dir.
  }
  return candidates;
}

/**
 * Create an isolated home for a sandboxed run.
 *
 * Usability is probed by creating the directory rather than by `access()`,
 * because a kernel sandbox can deny the write while `access()` still reports
 * the path writable.
 *
 * @returns Path to a fresh temporary home outside the OS temp dir when possible.
 */
export function createSandboxHome(): string {
  for (const base of sandboxHomeBases()) {
    try {
      return mkdtempSync(join(base, "devintern-e2e-home-"));
    } catch {
      // Try the next candidate.
    }
  }
  return mkdtempSync(join(tmpdir(), "devintern-e2e-home-"));
}

/**
 * Build the allowlisted environment for a sandboxed CLI run.
 *
 * @param root - Isolated workspace root.
 * @param home - Isolated home (see {@link createSandboxHome}).
 * @returns Environment with HOME, XDG config and TMPDIR separated so the
 *   agent's writable temp grant does not also cover its home directory.
 */
export function sandboxEnvironment(root: string, home: string): Record<string, string> {
  const temp = join(root, "tmp");
  mkdirSync(temp, { recursive: true });
  return {
    ...isolatedEnvironment(root),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: temp,
    AGENT_SANDBOX: "nono",
  };
}

/**
 * Shell agent used by the sandbox suite.
 *
 * Records one JSON line per check into `E2E_SANDBOX_REPORT`, then edits the
 * fixture greeting and prints the summary block the CLI expects so the run can
 * commit and push. Shell only: the probe never needs a sandbox-granted
 * toolchain, which keeps the assertion about the boundary independent of how
 * the developer installed Bun.
 */
const SANDBOX_AGENT_SOURCE = `#!/bin/sh
set -u
report="\${E2E_SANDBOX_REPORT:?E2E_SANDBOX_REPORT is required}"
: > "$report" || exit 1
record() {
  printf '{"check":"%s","ok":%s,"detail":"%s"}\\n' "$1" "$2" "\${3:-}" >> "$report"
}

cap="\${NONO_CAP_FILE:-}"
if [ -n "$cap" ] && [ -f "$cap" ]; then
  record nono-marker true "$cap"
else
  record nono-marker false "\${cap:-unset}"
fi
record working-dir true "$(pwd)"

if printf probe > .sandbox-probe-write 2>/dev/null; then
  record working-dir-write true "$(pwd)/.sandbox-probe-write"
  rm -f .sandbox-probe-write
else
  record working-dir-write false denied
fi

if printf probe > "$TMPDIR/sandbox-probe-write" 2>/dev/null; then
  record temp-write true "$TMPDIR"
else
  record temp-write false denied
fi

if printf probe > "$HOME/sandbox-escape" 2>/dev/null; then
  record home-write true "$HOME"
else
  record home-write false denied
fi

if [ -f "$HOME/sandbox-secret.txt" ] && read -r secret < "$HOME/sandbox-secret.txt" &&
  [ "$secret" = "${SANDBOX_SECRET}" ]; then
  record home-read true "$HOME/sandbox-secret.txt"
else
  record home-read false denied
fi

if printf 'export const greeting = "Hello, world!";\\n' > src/greeting.ts 2>/dev/null; then
  record repo-edit true src/greeting.ts
else
  record repo-edit false denied
  exit 1
fi

cat <<'SUMMARY'
<!-- devintern:summary:start -->
## Why
The sandbox probe exercises the confined agent boundary.
## What changed
Updated src/greeting.ts to export Hello, world!.
## Scope
The greeting export is the only changed file.
## Tradeoffs
A shell probe keeps the boundary check independent of agent toolchains.
## Blast Radius
The greeting test consumes the export and still passes.
## Verification
Confirmed the working directory stays writable inside the sandbox.
<!-- devintern:summary:end -->
SUMMARY
`;

/** Result of one probe check, parsed from the agent's report. */
export interface SandboxCheck {
  ok: boolean;
  detail: string;
}

/**
 * A fixture workspace whose agent runs under nono.
 *
 * Mirrors {@link import("./fixture-workspace").FixtureWorkspace} but keeps the
 * isolated home outside the temp dir and installs the shell probe agent, so
 * the suite can assert filesystem confinement rather than task lifecycle
 * details already covered by the CLI suite.
 */
export class SandboxWorkspace {
  readonly root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-"));
  readonly cwd = join(this.root, "repo");
  readonly home = createSandboxHome();
  readonly id = `e2e-${crypto.randomUUID()}`;
  readonly base = `e2e/base-${this.id}`;
  readonly head = `feature/${this.id}`;
  readonly agentPath = join(this.home, "bin", SANDBOX_AGENT_NAME);
  readonly reportPath = join(this.root, "output", "sandbox-report.jsonl");
  readonly env = sandboxEnvironment(this.root, this.home);

  constructor() {
    mkdirSync(join(this.home, "bin"), { recursive: true });
  }

  /**
   * Seed the fixture repository, remote and task file, then install the probe
   * agent and its readable secret.
   *
   * @returns The workspace, ready for {@link run}.
   */
  async prepare(): Promise<this> {
    mkdirSync(this.cwd, { recursive: true });
    cpSync(join(import.meta.dir, "../fixtures/simple-project"), this.cwd, { recursive: true });
    const remote = join(this.root, "remote.git");
    await checkedCommand(
      ["git", "init", "--bare", "--initial-branch", this.base, remote],
      this.root,
      this.env,
    );
    await this.git("init", "--initial-branch", this.base);
    await this.git("remote", "add", "origin", remote);
    await this.git("add", ".");
    await this.git("commit", "-m", "Seed isolated sandbox fixture");
    await this.git("push", "--set-upstream", "origin", this.base);

    writeFileSync(this.agentPath, SANDBOX_AGENT_SOURCE);
    writeFileSync(join(this.home, "sandbox-secret.txt"), `${SANDBOX_SECRET}\n`);
    chmodSync(this.agentPath, 0o700);
    writeFileSync(
      join(this.root, `${this.id}.md`),
      `---\nkey: ${this.id}\n---\n# Expand the greeting\n\nChange the greeting to Hello, world!.\n`,
    );
    this.env.E2E_SANDBOX_REPORT = this.reportPath;
    return this;
  }

  /**
   * Run one task through the built CLI with the probe agent.
   *
   * @param overrides - Environment overrides for this run.
   * @returns The CLI's exit code and captured output.
   */
  async run(overrides: Record<string, string> = {}) {
    return command(
      [
        process.execPath,
        cliPath,
        join(this.root, `${this.id}.md`),
        "--agent-path",
        this.agentPath,
        "--skip-clarity-check",
        "--skip-comments",
        "--create-pr",
        "--pr-target-branch",
        this.base,
        "--hook-retries",
        "0",
        "--no-update",
      ],
      this.cwd,
      { ...this.env, ...overrides },
    );
  }

  /**
   * Parse the probe report into check results.
   *
   * @returns Results keyed by check name; empty when the agent never ran.
   */
  checks(): Record<string, SandboxCheck> {
    if (!existsSync(this.reportPath)) return {};
    const checks: Record<string, SandboxCheck> = {};
    for (const line of readFileSync(this.reportPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { check: string; ok: boolean; detail: string };
      checks[entry.check] = { ok: entry.ok, detail: entry.detail };
    }
    return checks;
  }

  git(...args: string[]): Promise<string> {
    return checkedCommand(["git", ...args], this.cwd, this.env);
  }

  /**
   * Read the remote tip of a branch.
   *
   * @param branch - Branch ref to resolve.
   * @returns The remote commit SHA, or undefined when the ref is absent.
   */
  async remoteSha(branch: string): Promise<string | undefined> {
    const value = await this.git("ls-remote", "origin", `refs/heads/${branch}`);
    return value ? value.split(/\s+/)[0] : undefined;
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
    rmSync(this.home, { recursive: true, force: true });
  }
}

/**
 * Build a PATH that cannot resolve nono, while keeping the toolchain and
 * system commands the parent CLI needs.
 *
 * @param source - PATH to filter (defaults to the process PATH).
 * @returns A PATH without any directory containing a `nono` executable.
 */
export function pathWithoutNono(source: string = process.env.PATH ?? ""): string {
  return source
    .split(delimiter)
    .filter((entry) => entry && !existsSync(join(entry, "nono")))
    .join(delimiter);
}

/**
 * Directory holding the Bun executable, so subprocesses that rely on
 * `#!/usr/bin/env bun` keep working when PATH is trimmed.
 *
 * @returns Absolute directory containing the current runtime.
 */
export function runtimeBinDir(): string {
  return dirname(process.execPath);
}
