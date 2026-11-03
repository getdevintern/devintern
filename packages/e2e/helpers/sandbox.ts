/**
 * Helpers for the sandbox end-to-end suite.
 *
 * The suite drives the built CLI with a deterministic shell agent wrapped by a
 * sandbox provider. For providers that can wrap an arbitrary process (nono)
 * it asserts the real boundary: writes inside the task workspace, temp
 * dir and output dir succeed, while writes elsewhere are denied. No AI account
 * or model call is involved.
 *
 * Provider detection and PATH filtering are shared by the fail-closed and
 * doctor tests so no test hardcodes a provider's executable name.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { detectSandboxProviders } from "@devintern/agent-harness";
import type { SandboxDetection } from "@devintern/agent-harness";
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
 * Executable each external provider needs on PATH.
 *
 * Docker Sandboxes ships as its own `sbx` CLI, not a `docker` subcommand, so
 * tests must not assume the provider name matches the binary name.
 */
const PROVIDER_BINARIES: Record<string, string | undefined> = {
  nono: "nono",
  docker: "sbx",
};

/**
 * Executable name a provider detects, or `undefined` for providers with no
 * external binary (for example the harness-native provider).
 *
 * @param provider - Registered provider name.
 * @returns The binary name, when the provider has one.
 */
export function providerBinary(provider: string): string | undefined {
  return PROVIDER_BINARIES[provider];
}

/**
 * Resolve a provider's binary, or `undefined` when it is unavailable on this
 * platform (or the provider has no binary).
 *
 * @param provider - Registered provider name.
 * @returns Absolute path to the provider binary, if installed.
 */
export function providerPath(provider: string): string | undefined {
  const binary = providerBinary(provider);
  if (!binary || process.platform === "win32") return undefined;
  return Bun.which(binary) ?? undefined;
}

/**
 * Resolve the nono binary, or `undefined` when unavailable on this platform.
 *
 * @returns Absolute path to nono, if installed.
 */
export function nonoPath(): string | undefined {
  return providerPath("nono");
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
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, "devintern-e2e-home-"));
    } catch {
      // Try the next candidate: an enclosing sandbox may deny this base.
    }
  }
  return mkdtempSync(join(tmpdir(), "devintern-e2e-home-"));
}

/**
 * Create an isolated home beside a workspace for non-nono providers.
 *
 * nono alone requires its home outside the OS temp dir (see
 * {@link createSandboxHome}); keeping other providers' homes under the test
 * workspace makes per-test cleanup and inspection straightforward.
 *
 * @param root - Isolated workspace root.
 * @returns Path to a fresh home directory under `root`.
 */
export function createProviderHome(root: string): string {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Candidate parents for the outside-the-boundary directory.
 *
 * Both must stay outside the OS temp dir. A provider's policy grants the temp
 * dir, and nono's Linux profile goes further: its `system_write_linux` group
 * allows write on `/tmp` itself, so *any* directory beneath `tmpdir()` is
 * writable by the wrapped agent. A directory under `/tmp` would therefore
 * make the escape check assert `true` and fail misleadingly.
 *
 * The package-local `.local` is preferred because cleanup is obvious and it is
 * usually outside the temp dir. `/var/tmp` is the fallback for checkouts that
 * live under the temp dir (CI scratch dirs, some local worktrees); it is not in
 * any provider write grant.
 *
 * @returns Candidate directories, most preferred first.
 */
function sandboxOutsideBases(): string[] {
  const packageLocal = join(import.meta.dir, "..", ".local");
  return process.platform === "win32" ? [packageLocal] : [packageLocal, "/var/tmp"];
}

/**
 * Whether a real path is `parent` itself or lives beneath it.
 *
 * @param candidate - Real path to test.
 * @param parent - Real path of the supposed ancestor.
 * @returns True when `candidate` is at or below `parent`.
 */
function isAtOrBelow(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  return candidate.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * Create a directory provably outside the OS temp dir.
 *
 * The base is resolved with `realpath` and rejected when it is at or below the
 * temp root, so a checkout under `/tmp` cannot silently produce a writable
 * "outside" directory. POSIX write permission is not enough when the suite
 * itself runs under a sandbox (Landlock can deny `/var/tmp` while
 * `access(W_OK)` still succeeds), so a candidate that cannot be created falls
 * through to the next one.
 *
 * @param bases - Candidate parents, most preferred first.
 * @param temp - Temp root the result must stay outside of (defaults to the OS temp dir).
 * @returns Path to a fresh directory outside `temp`, or undefined when no
 *   candidate qualifies (callers must skip the escape assertion rather than
 *   assert a false escape).
 */
export function createSandboxOutside(
  bases: readonly string[] = sandboxOutsideBases(),
  temp: string = tmpdir(),
): string | undefined {
  const tempRoot = realpathSync(temp);
  for (const base of bases) {
    try {
      mkdirSync(base, { recursive: true });
      const resolved = realpathSync(base);
      if (isAtOrBelow(resolved, tempRoot)) continue;
      return mkdtempSync(join(resolved, "devintern-e2e-outside-"));
    } catch {
      // Try the next candidate: an enclosing sandbox may deny this base.
    }
  }
  return undefined;
}

/**
 * Build the allowlisted environment for a sandboxed CLI run.
 *
 * @param root - Isolated workspace root.
 * @param home - Isolated home (see {@link createSandboxHome} or
 *   {@link createProviderHome}).
 * @param provider - `AGENT_SANDBOX` value for the run (defaults to nono).
 * @returns Environment with HOME, XDG config and TMPDIR separated so the
 *   agent's writable temp grant does not also cover its home directory.
 */
export function sandboxEnvironment(
  root: string,
  home: string,
  provider = "nono",
): Record<string, string> {
  const temp = join(root, "tmp");
  mkdirSync(temp, { recursive: true });
  return {
    ...isolatedEnvironment(root),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: temp,
    AGENT_SANDBOX: provider,
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

output_dir="\${DEVINTERN_OUTPUT_DIR:-}"
if [ -n "$output_dir" ] && mkdir -p "$output_dir" 2>/dev/null &&
  printf probe > "$output_dir/sandbox-probe-write" 2>/dev/null; then
  record output-write true "$output_dir"
  rm -f "$output_dir/sandbox-probe-write"
else
  record output-write false denied
fi

outside="\${E2E_SANDBOX_OUTSIDE:-}"
if [ -n "$outside" ]; then
  if printf probe > "$outside/sandbox-escape" 2>/dev/null; then
    record outside-write true "$outside/sandbox-escape"
  else
    record outside-write false denied
  fi
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

/** Options for {@link SandboxWorkspace}. */
export interface SandboxWorkspaceOptions {
  /** Provider the workspace's `AGENT_SANDBOX` starts as (defaults to nono). */
  provider?: string;
  /**
   * Isolated home override. Defaults to nono's home outside the OS temp dir
   * for nono, or a workspace-local home for every other provider.
   */
  home?: string;
}

/**
 * A fixture workspace whose agent runs under a sandbox provider.
 *
 * Mirrors {@link import("./fixture-workspace").FixtureWorkspace} but keeps the
 * isolated home outside the temp dir for nono and installs the shell probe
 * agent, so the suite can assert filesystem confinement rather than task
 * lifecycle details already covered by the CLI suite.
 */
export class SandboxWorkspace {
  readonly root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-"));
  readonly cwd = join(this.root, "repo");
  /**
   * Host path deliberately outside every writable grant, or undefined when the
   * host offers no such directory (see {@link createSandboxOutside}). Callers
   * must not assert an escape when this is undefined.
   */
  readonly outside = createSandboxOutside();
  readonly id = `e2e-${crypto.randomUUID()}`;
  readonly base = `e2e/base-${this.id}`;
  readonly head = `feature/${this.id}`;
  readonly provider: string;
  readonly home: string;
  readonly agentPath: string;
  readonly reportPath: string;
  readonly env: Record<string, string>;

  constructor(options: SandboxWorkspaceOptions = {}) {
    this.provider = options.provider ?? "nono";
    this.home =
      options.home ??
      (this.provider === "nono" ? createSandboxHome() : createProviderHome(this.root));
    this.reportPath = join(this.root, "output", "sandbox-report.jsonl");
    this.agentPath = join(this.home, "bin", SANDBOX_AGENT_NAME);
    this.env = sandboxEnvironment(this.root, this.home, this.provider);
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
    // A host path deliberately outside every writable grant, so the probe can
    // prove the boundary denies writes outside the workspace. When the host has
    // no such path the probe skips its escape check (see SandboxWorkspace.outside).
    this.env.E2E_SANDBOX_REPORT = this.reportPath;
    if (this.outside) {
      this.env.E2E_SANDBOX_OUTSIDE = this.outside;
    }
    return this;
  }

  /**
   * Run one task through the built CLI with the probe agent.
   *
   * @param overrides - Environment overrides for this run.
   * @param extraArgs - Additional CLI arguments appended to the base argv
   *   (for example `--sandbox nono`). The flag wins over `AGENT_SANDBOX`.
   * @returns The CLI's exit code and captured output.
   */
  async run(overrides: Record<string, string> = {}, extraArgs: readonly string[] = []) {
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
        ...extraArgs,
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
    if (this.outside) rmSync(this.outside, { recursive: true, force: true });
  }
}

/**
 * Build a PATH that cannot resolve one executable, while keeping the
 * toolchain and system commands the parent CLI needs.
 *
 * @param binary - Executable name to remove (for example `nono`).
 * @param source - PATH to filter (defaults to the process PATH).
 * @returns A PATH without any directory containing that executable.
 */
export function pathWithoutBinary(binary: string, source: string = process.env.PATH ?? ""): string {
  return source
    .split(delimiter)
    .filter((entry) => entry && !existsSync(join(entry, binary)))
    .join(delimiter);
}

/**
 * Build a PATH that cannot resolve a provider's binary.
 *
 * @param provider - Registered provider name.
 * @param source - PATH to filter (defaults to the process PATH).
 * @returns A PATH without the provider's executable.
 */
export function pathWithoutProvider(
  provider: string,
  source: string = process.env.PATH ?? "",
): string {
  const binary = providerBinary(provider);
  return binary ? pathWithoutBinary(binary, source) : source;
}

/**
 * Build a PATH that cannot resolve nono, while keeping the toolchain and
 * system commands the parent CLI needs.
 *
 * @param source - PATH to filter (defaults to the process PATH).
 * @returns A PATH without any directory containing a `nono` executable.
 */
export function pathWithoutNono(source: string = process.env.PATH ?? ""): string {
  return pathWithoutBinary("nono", source);
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

/**
 * Write a small executable stub.
 *
 * @param dir - Directory to create the stub in.
 * @param name - Executable file name.
 * @param source - Shell script contents (defaults to a harness that just prints `stub`).
 * @returns Absolute path to the stub.
 */
export function stubExecutable(
  dir: string,
  name: string,
  source = '#!/bin/sh\necho "stub"\n',
): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  chmodSync(path, 0o700);
  return path;
}

/**
 * Write a harness CLI stub that accepts `--version` and any probe flags.
 *
 * @param dir - Directory to create the stub in.
 * @param name - Harness executable name.
 * @returns Absolute path to the stub.
 */
export function stubHarness(dir: string, name: string): string {
  return stubExecutable(dir, name);
}

/** Whether a provider can actually run on this host, and why not when it cannot. */
export interface ProviderPrerequisite {
  usable: boolean;
  reason: string;
}

function firstLine(text: string): string {
  return (
    text
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "no output"
  );
}

/**
 * Detection result for one provider, reusing the CLI's own detector.
 *
 * Detection alone is not enough for a start-up probe, but it is decisive for
 * the opposite direction: when the CLI would report the provider unavailable
 * (missing binary or a missing Linux dependency), a boundary test must skip
 * instead of failing for an environmental reason.
 *
 * @param provider - Registered provider name.
 * @returns The provider's detection, or undefined for an unregistered name.
 */
async function providerDetection(provider: string): Promise<SandboxDetection | undefined> {
  const detections = await detectSandboxProviders();
  return detections.find((entry) => entry.provider.name === provider)?.detection;
}

function probeDocker(providerPathValue: string): ProviderPrerequisite {
  const result = spawnSync(providerPathValue, ["ls"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    return {
      usable: false,
      reason: `sbx is not signed in or the daemon is unreachable: ${firstLine(
        result.stderr || result.stdout || result.error?.message || "no output",
      )}`,
    };
  }
  return { usable: true, reason: "sbx ls succeeds" };
}

/**
 * Check whether an optional real-provider boundary test can run on this host.
 *
 * Detection alone is not enough for a boundary test: the provider must also be
 * able to start. An unsigned or unreachable `sbx` reports unusable here instead
 * of failing a boundary test for environmental reasons.
 *
 * The gate starts from the provider's own {@link detectSandboxProviders}
 * result, so it mirrors the CLI exactly: a host where a required dependency is
 * missing skips here instead of running a boundary test the CLI would refuse.
 *
 * @param provider - Registered provider name.
 * @returns Whether the provider can run, plus an honest skip reason.
 */
export async function providerPrerequisite(provider: string): Promise<ProviderPrerequisite> {
  if (process.platform === "win32") {
    return { usable: false, reason: "sandbox providers are supported on macOS/Linux only" };
  }
  // Registration comes first: an unknown name has no detection entry, and the
  // no-binary fast path below must not let it through as "usable".
  const detection = await providerDetection(provider);
  if (!detection) {
    return { usable: false, reason: `no registered sandbox provider named "${provider}"` };
  }
  const binary = providerBinary(provider);
  if (!binary) {
    return { usable: true, reason: `${provider} has no external binary to probe` };
  }
  if (!detection.available) {
    return { usable: false, reason: detection.reason ?? `${binary} is not usable on this machine` };
  }
  const path = providerPath(provider);
  if (!path) {
    return { usable: false, reason: `${binary} is not on the test process PATH` };
  }
  switch (provider) {
    case "docker":
      return probeDocker(path);
    default:
      return { usable: true, reason: `${provider} has no start-up prerequisite probe` };
  }
}
