import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execSync, spawn as nodeSpawn, spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { bunSandboxOverlay, isPathWithin, sandboxBunEnv } from "../src/sandbox/bun-env.js";
import { DockerSandboxProvider } from "../src/sandbox/providers/docker.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";

// Bun's mock.module patches the existing module in place, so the namespace
// cannot be used to call through after registration: capture the real
// spawnSync up front and delegate to it from the stub below.
const realSpawnSync = spawnSync;

// The Linux Landlock preflight inside NonoSandboxProvider.wrapCommand shells
// out to `nono run … -- true`; these tests assert argv composition, not the
// host-dependent grant refinement, so stub just that spawn to a fast no-op.
// `nono profile show <name>` is stubbed separately so tests can simulate a
// machine where the harness pack is (not) installed.
// mock.module is process-global for the whole `bun test` run, so every other
// export — and every non-`nono` spawnSync call — must delegate to the real
// implementation, otherwise the stub leaks into other test files (e.g.
// sandbox-detect.test.ts) and breaks their live-probe assertions.
let nonoPackInstalled = true;
// The kernel-write integration test opts into the real preflight so the
// provider can refine host-specific deny overlaps before spawning; every other
// test keeps the fast no-op stub.
let nonoRunReal = false;
mock.module("child_process", () => ({
  execSync,
  spawn: nodeSpawn,
  spawnSync: (...callArgs: Parameters<typeof realSpawnSync>) => {
    if (callArgs[0] !== "nono") return realSpawnSync(...callArgs);
    const args = (callArgs[1] ?? []) as string[];
    if (args[0] === "profile" && args[1] === "show") {
      return nonoPackInstalled
        ? { status: 0, stdout: "nono: profile: profile 'stub'", stderr: "" }
        : { status: 1, stdout: "", stderr: "nono: Profile not found" };
    }
    if (nonoRunReal && args[0] === "run") return realSpawnSync(...callArgs);
    return { status: 0, stdout: "", stderr: "" };
  },
}));

const {
  NonoSandboxProvider,
  describeNonoPack,
  parseDenyOverlaps,
  refineGrantsAgainstDenies,
  resetNonoPackState,
} = await import("../src/sandbox/providers/nono.js");

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    writablePaths: ["/work/repo", "/tmp/devintern-tasks"],
    network: "open",
    workingDir: "/work/repo",
    harnessName: "claude-code",
    ...overrides,
  };
}

describe("NonoSandboxProvider.wrapCommand", () => {
  const originalEnv = { ...process.env };
  let tempHome: string;
  beforeEach(() => {
    delete process.env.AGENT_SANDBOX_NONO_PROFILE;
    // A temp HOME keeps the default Bun cache (~/.cache) writable even when
    // the test process runs inside a sandbox that makes the real home read-only.
    tempHome = mkdtempSync(join(tmpdir(), "nono-wrap-home-"));
    process.env.HOME = tempHome;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("wraps the agent after -- with policy grants and no profile by default", () => {
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      ["-p", "hi"],
      policy(),
    );
    expect(wrapped.path).toBe("nono");
    expect(wrapped.args[0]).toBe("run");
    // With no env override, macOS uses the harness's nono pack profile when
    // installed (absent otherwise); Linux always passes a generated composite
    // profile file extending linux-host-compat (+ the pack when installed).
    const profileIdx = wrapped.args.indexOf("--profile");
    if (process.platform === "linux") {
      expect(profileIdx).not.toBe(-1);
      const profilePath = wrapped.args[profileIdx + 1] as string;
      expect(profilePath.endsWith("profile.jsonc")).toBe(true);
      const generated = JSON.parse(readFileSync(profilePath, "utf8"));
      expect(generated.extends[0]).toBe("linux-host-compat");
      expect(generated.filesystem.read).toContain("/etc");
    } else if (profileIdx !== -1) {
      expect(wrapped.args[profileIdx + 1]).toBe("claude-code");
    }
    // Agent argv sits verbatim after the -- separator.
    const sep = wrapped.args.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(wrapped.args.slice(sep + 1)).toEqual(["/usr/bin/claude", "-p", "hi"]);
    // Policy writable paths become --allow grants (workingDir may not exist
    // in the test env; the granted set is drawn from the policy).
    const allowIdx = wrapped.args.indexOf("--allow");
    expect(allowIdx === -1 || allowIdx < sep).toBe(true);
    // $HOME read grants never touch nono's protected state root.
    for (let i = 0; i < sep; i++) {
      if (wrapped.args[i] === "--read" || wrapped.args[i] === "--allow") {
        expect(wrapped.args[i + 1]).not.toContain(".local/state/nono");
        expect(wrapped.args[i + 1]).not.toBe(process.env.HOME);
      }
    }
  });

  test("gives Bun a writable install/temp root instead of ~/.bun", () => {
    const wrapped = new NonoSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
    const env = wrapped.env;
    expect(env).toBeDefined();
    const install = env!.BUN_INSTALL as string;
    const temp = env!.BUN_TMPDIR as string;
    const bunHome = join(process.env.HOME ?? homedir(), ".bun");

    // Never point a sandboxed child at the user's real (read-only) install.
    for (const p of [install, temp]) {
      expect(typeof p).toBe("string");
      expect(p.startsWith(bunHome)).toBe(false);
      // Created before spawn so the child's first write cannot hit ENOENT.
      expect(existsSync(p)).toBe(true);
    }

    // Both paths are inside an explicit --allow grant in the generated argv.
    const sep = wrapped.args.indexOf("--");
    const allows: string[] = [];
    for (let i = 0; i < sep; i++) {
      if (wrapped.args[i] === "--allow") allows.push(wrapped.args[i + 1] as string);
    }
    const underAllow = (p: string) => allows.some((root) => p === root || p.startsWith(`${root}/`));
    expect(underAllow(install)).toBe(true);
    expect(underAllow(temp)).toBe(true);

    // `bun install -g` writes launchers under <BUN_INSTALL>/bin; a redirected
    // install root must be on PATH, but appended so it cannot shadow system
    // tools (a sandboxed run can write there).
    expect(env!.PATH?.endsWith(`${delimiter}${join(install, "bin")}`)).toBe(true);
    // Its skip cache under ~/.devintern is read-only here, so an in-sandbox
    // self-update would install into the disposable root and re-exec forever.
    expect(env!.DEVINTERN_NO_UPDATE).toBe("1");
    expect(env!.DEVPM_NO_UPDATE).toBe("1");
  });

  test("a child Bun process can write under a sandbox Bun root", () => {
    // Use a private temp base instead of the shared default so the probe cannot
    // contaminate the cache real runs use.
    const root = mkdtempSync(join(tmpdir(), "bun-env-write-"));
    try {
      const bun = sandboxBunEnv(join(root, "cache"));
      const probe = join(bun.env.BUN_INSTALL, `probe-${process.pid}.txt`);
      const result = spawnSync(
        process.execPath,
        ["-e", `await Bun.write(${JSON.stringify(probe)}, "ok")`],
        { encoding: "utf8", env: { ...process.env, ...bun.env }, timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(probe, "utf8")).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nono-sandboxed child can write under the sandbox Bun root", () => {
    // Integration: this crosses the real kernel boundary using the argv the
    // provider generated. Skip cleanly where nono is absent or where this
    // process is already sandboxed (kernel sandboxes cannot nest).
    const version = realSpawnSync("nono", ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (version.error || version.status !== 0) {
      console.warn("[sandbox] nono not available; skipping the kernel write test");
      return;
    }
    if (process.env.NONO_CAP_FILE || process.env.SANDBOX_RUNTIME === "1") {
      console.warn("[sandbox] already inside a sandbox; skipping the nested nono write test");
      return;
    }
    if (process.platform !== "linux") {
      console.warn("[sandbox] kernel write test uses the Linux base profile; skipping");
      return;
    }

    const originalHome = process.env.HOME;
    const originalProfile = process.env.AGENT_SANDBOX_NONO_PROFILE;
    // The real home, not the temp one from `beforeEach`: nono's Linux base
    // profile grants /tmp read, so a HOME nested under /tmp turns its
    // credential denies into unenforceable deny-over-allow overlaps and
    // `nono run` refuses to start. The test only reaches this point outside a
    // sandbox, where the real home is writable; the workspace-scoped cache
    // root is removed in `finally`.
    const realHome = originalEnv.HOME ?? homedir();
    if (isPathWithin(realHome, [tmpdir()])) {
      console.warn("[sandbox] HOME is under the temp dir; skipping the nono write test");
      return;
    }
    const work = mkdtempSync(join(tmpdir(), "nono-bun-work-"));
    process.env.HOME = realHome;
    // Same deterministic per-workspace root the provider will overlay. HOME
    // must already point at the child's home: the base lives under $HOME.
    const bun = sandboxBunEnv(undefined, work);
    const probe = join(bun.env.BUN_INSTALL, `nono-probe-${process.pid}.txt`);
    // The pack probe is stubbed in this file; name the built-in base profile
    // directly so the real `nono run` does not reference an uninstalled pack.
    process.env.AGENT_SANDBOX_NONO_PROFILE = "linux-host-compat";
    // Let the provider's Landlock preflight reach the real `nono`. This file
    // otherwise stubs every `nono` spawn, and an unrefined grant set is refused
    // on hosts whose profile denies paths under a broad home grant (for
    // example linux-host-compat's `$HOME/.config` credential denies versus the
    // top-level `--read $HOME/.config`). Production refines those grants in the
    // preflight; skipping the stub here exercises that path end to end.
    nonoRunReal = true;
    try {
      const wrapped = new NonoSandboxProvider().wrapCommand(
        process.execPath,
        ["-e", `await Bun.write(${JSON.stringify(probe)}, "ok")`],
        policy({ workingDir: work, writablePaths: [work] }),
      );
      // The child's BUN_INSTALL must be the granted cache, not ~/.bun.
      expect(wrapped.env?.BUN_INSTALL).toBe(bun.env.BUN_INSTALL);
      const result = realSpawnSync(wrapped.path, wrapped.args, {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, ...wrapped.env },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(probe, "utf8")).toBe("ok");
    } finally {
      nonoRunReal = false;
      process.env.HOME = originalHome;
      if (originalProfile === undefined) delete process.env.AGENT_SANDBOX_NONO_PROFILE;
      else process.env.AGENT_SANDBOX_NONO_PROFILE = originalProfile;
      rmSync(probe, { force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(bun.writablePath, { recursive: true, force: true });
    }
  });

  test("preserves a configured Bun root the sandbox grants write access to", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-configured-"));
    const workingDir = join(root, "work");
    const install = join(workingDir, ".bun");
    const temp = join(workingDir, ".bun-tmp");
    mkdirSync(workingDir);
    mkdirSync(install);
    mkdirSync(temp);
    process.env.BUN_INSTALL = install;
    process.env.BUN_TMPDIR = temp;
    try {
      const wrapped = new NonoSandboxProvider().wrapCommand(
        "/usr/bin/claude",
        [],
        policy({ workingDir, writablePaths: [workingDir] }),
      );
      // Sibling consumers (e.g. the CLI self-update's `bun install -g`) read
      // BUN_INSTALL from the child env; an explicit value the sandbox `--allow`s
      // must survive the overlay instead of being redirected into the cache.
      expect(wrapped.env?.BUN_INSTALL).toBeUndefined();
      expect(wrapped.env?.BUN_TMPDIR).toBeUndefined();
      // A writable install root keeps its existing PATH and may self-update.
      expect(wrapped.env?.PATH).toBeUndefined();
      expect(wrapped.env?.DEVINTERN_NO_UPDATE).toBeUndefined();
      const sep = wrapped.args.indexOf("--");
      const allows: string[] = [];
      for (let i = 0; i < sep; i++) {
        if (wrapped.args[i] === "--allow") allows.push(wrapped.args[i + 1] as string);
      }
      expect(allows).toContain(workingDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("overrides a configured Bun root the sandbox grants read access only", () => {
    // Regression: the Bun installer's default is `BUN_INSTALL=$HOME/.bun`.
    // That path is writable for this process, but the child only gets a
    // `--read` grant on top-level $HOME entries, so preserving it left
    // `bun install` failing with EACCES.
    const home = mkdtempSync(join(tmpdir(), "bun-env-home-"));
    const install = join(home, ".bun");
    mkdirSync(install);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    process.env.BUN_INSTALL = install;
    process.env.BUN_TMPDIR = join(home, ".bun-tmp");
    try {
      const wrapped = new NonoSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
      expect(wrapped.env?.BUN_INSTALL).toBeDefined();
      expect(wrapped.env?.BUN_INSTALL).not.toBe(install);
      expect(wrapped.env?.BUN_TMPDIR).toBeDefined();
      expect(wrapped.env?.BUN_TMPDIR).not.toBe(process.env.BUN_TMPDIR);

      const sep = wrapped.args.indexOf("--");
      const allows: string[] = [];
      const reads: string[] = [];
      for (let i = 0; i < sep; i++) {
        if (wrapped.args[i] === "--allow") allows.push(wrapped.args[i + 1] as string);
        if (wrapped.args[i] === "--read") reads.push(wrapped.args[i + 1] as string);
      }
      // The premise of the bug: the configured root is read-only in the argv.
      expect(reads).toContain(install);
      expect(allows).not.toContain(install);
      // The replacement cache is granted read+write.
      const cacheRoot = wrapped.env!.BUN_INSTALL as string;
      expect(allows.some((r) => cacheRoot === r || cacheRoot.startsWith(`${r}/`))).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("bases the overlay on the child env, not on process.env", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-child-"));
    const workingDir = join(root, "work");
    const childAllowed = join(workingDir, "child-bun");
    const childReadOnly = join(root, "process-bun");
    mkdirSync(workingDir);
    mkdirSync(childAllowed);
    mkdirSync(childReadOnly);
    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      // process.env says "allowed" but the child gets a different (read-only)
      // value: the decision must follow the child env and override it.
      process.env.BUN_INSTALL = childAllowed;
      const overridden = new NonoSandboxProvider().wrapCommand(
        "/usr/bin/claude",
        [],
        policy({
          workingDir,
          writablePaths: [workingDir],
          env: { HOME: root, BUN_INSTALL: childReadOnly },
        }),
      );
      expect(overridden.env?.BUN_INSTALL).toBeDefined();
      expect(overridden.env?.BUN_INSTALL).not.toBe(childReadOnly);

      // process.env says "read-only" but the child gets an allowed value: the
      // child's value must be preserved.
      process.env.BUN_INSTALL = childReadOnly;
      const preserved = new NonoSandboxProvider().wrapCommand(
        "/usr/bin/claude",
        [],
        policy({
          workingDir,
          writablePaths: [workingDir],
          env: { HOME: root, BUN_INSTALL: childAllowed },
        }),
      );
      expect(preserved.env?.BUN_INSTALL).toBeUndefined();
    } finally {
      process.env.HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces configured Bun paths that are not writable", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-missing-"));
    const missing = join(root, "missing");
    process.env.BUN_INSTALL = missing;
    delete process.env.BUN_TMPDIR;
    try {
      const wrapped = new NonoSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
      expect(wrapped.env?.BUN_INSTALL).toBeDefined();
      expect(wrapped.env?.BUN_INSTALL).not.toBe(missing);
      expect(wrapped.env?.BUN_TMPDIR).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("omits the Bun overlay when the cache root cannot be created safely", () => {
    const fakeUid = 999_999_999;
    const realGetuid = process.getuid;
    const home = mkdtempSync(join(tmpdir(), "bun-env-fail-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    process.getuid = () => fakeUid;
    try {
      const wrapped = new NonoSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
      // Wrapping must still succeed: a broken cache may only cost the overlay.
      expect(wrapped.env?.BUN_INSTALL).toBeUndefined();
      expect(wrapped.env?.BUN_TMPDIR).toBeUndefined();
      // The base is created but ownership validation rejects it (the process
      // pretends to be another uid), so the overlay is omitted.
      expect(existsSync(join(home, ".cache", "devintern", "bun"))).toBe(true);
    } finally {
      process.getuid = realGetuid;
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("passes AGENT_SANDBOX_NONO_PROFILE as --profile", () => {
    process.env.AGENT_SANDBOX_NONO_PROFILE = "devintern";
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      ["-p", "hi"],
      policy(),
    );
    expect(wrapped.args.slice(0, 3)).toEqual(["run", "--profile", "devintern"]);
    const sep = wrapped.args.indexOf("--");
    expect(wrapped.args.slice(sep + 1)).toEqual(["/usr/bin/claude", "-p", "hi"]);
  });

  test("maps a domain allowlist to repeated --allow-domain flags", () => {
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/claude",
      [],
      policy({ network: { allowedDomains: ["api.anthropic.com", "github.com"] } }),
    );
    const domains = wrapped.args
      .map((a, i) => (a === "--allow-domain" ? wrapped.args[i + 1] : null))
      .filter(Boolean);
    expect(domains).toEqual(["api.anthropic.com", "github.com"]);
  });

  test("grants cursor-agent write access to ~/.config/cursor", () => {
    const home = process.env.HOME ?? "";
    const cursorConfig = join(home, ".config/cursor");
    if (!existsSync(cursorConfig)) return; // machine-dependent; skip when absent
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/cursor-agent",
      ["-p", "hi"],
      policy({ harnessName: "cursor" }),
    );
    const sep = wrapped.args.indexOf("--");
    const allows: string[] = [];
    for (let i = 0; i < sep; i++) {
      if (wrapped.args[i] === "--allow") allows.push(wrapped.args[i + 1] as string);
    }
    expect(allows).toContain(cursorConfig);
  });

  test("grants OpenCode write access to its state locks without granting nono state", () => {
    const home = process.env.HOME ?? "";
    const stateDir = join(home, ".local/state/opencode");
    if (!existsSync(stateDir)) return;
    const wrapped = new NonoSandboxProvider().wrapCommand(
      "/usr/bin/opencode",
      ["run", "test"],
      policy({ harnessName: "opencode" }),
    );
    const grants = wrapped.args.flatMap((arg, index) =>
      arg === "--allow" ? [wrapped.args[index + 1]] : [],
    );
    expect(grants).toContain(stateDir);
    expect(grants).not.toContain(join(home, ".local/state"));
  });

  test("grants /dev/ptmx so lefthook can allocate a PTY", () => {
    if (!existsSync("/dev/ptmx")) return; // absent on some constrained hosts
    const wrapped = new NonoSandboxProvider().wrapCommand("/usr/bin/claude", [], policy());
    const sep = wrapped.args.indexOf("--");
    const allowFiles: string[] = [];
    for (let i = 0; i < sep; i++) {
      if (wrapped.args[i] === "--allow-file") allowFiles.push(wrapped.args[i + 1] as string);
    }
    expect(allowFiles).toContain("/dev/ptmx");
  });
});

describe("sandboxBunEnv", () => {
  test("creates a private root and child directories with mode 0700", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-create-"));
    try {
      const base = join(root, "cache");
      const bun = sandboxBunEnv(base);
      expect(bun.writablePath).toBe(base);
      for (const p of [base, bun.env.BUN_INSTALL, bun.env.BUN_TMPDIR]) {
        expect(existsSync(p)).toBe(true);
        expect(statSync(p).mode & 0o777).toBe(0o700);
      }
      expect(bun.env.BUN_INSTALL).toBe(join(base, "install"));
      expect(bun.env.BUN_TMPDIR).toBe(join(base, "tmp"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked base without creating anything through it", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-link-"));
    try {
      const target = join(root, "target");
      const link = join(root, "link");
      mkdirSync(target);
      symlinkSync(target, link);
      expect(() => sandboxBunEnv(link)).toThrow(/symlink/i);
      // A followed link would have created install/ inside the target.
      expect(existsSync(join(target, "install"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a base that is a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-file-"));
    try {
      const file = join(root, "cache");
      writeFileSync(file, "not a directory");
      expect(() => sandboxBunEnv(file)).toThrow(/not a directory/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an unwritable base", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses mode bits
    const root = mkdtempSync(join(tmpdir(), "bun-env-readonly-"));
    const base = join(root, "cache");
    mkdirSync(base, { mode: 0o500 });
    try {
      expect(() => sandboxBunEnv(base)).toThrow();
    } finally {
      chmodSync(base, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scopes the cache per workspace so repositories cannot share launchers", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-workspace-"));
    try {
      const base = join(root, "cache");
      const a = sandboxBunEnv(base, "/repos/a");
      const b = sandboxBunEnv(base, "/repos/b");
      expect(a.writablePath).not.toBe(b.writablePath);
      expect(a.env.BUN_INSTALL).not.toBe(b.env.BUN_INSTALL);
      // Stable within a workspace so the warm cache is reused across runs.
      expect(sandboxBunEnv(base, "/repos/a").writablePath).toBe(a.writablePath);

      // Simulate repo A planting a launcher: repo B's PATH must not reach it.
      mkdirSync(join(a.env.BUN_INSTALL, "bin"), { recursive: true });
      writeFileSync(join(a.env.BUN_INSTALL, "bin", "git"), "PLANTED");
      const overlay = bunSandboxOverlay(b, [], { PATH: "/usr/bin:/bin" });
      expect(overlay.env.PATH).not.toContain(a.env.BUN_INSTALL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appends the cache bin so a planted launcher cannot shadow a system tool", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-path-"));
    const system = join(root, "system");
    mkdirSync(system);
    writeFileSync(join(system, "probe-tool"), "#!/bin/sh\necho SYSTEM\n", { mode: 0o755 });
    try {
      const bun = sandboxBunEnv(join(root, "cache"));
      const bin = join(bun.env.BUN_INSTALL, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "probe-tool"), "#!/bin/sh\necho PLANTED\n", { mode: 0o755 });

      const childPath = `${system}${delimiter}${process.env.PATH ?? ""}`;
      const overlay = bunSandboxOverlay(bun, [], { PATH: childPath });
      expect(overlay.env.PATH).toBe(`${childPath}${delimiter}${bin}`);
      const result = spawnSync("sh", ["-c", "probe-tool"], {
        encoding: "utf8",
        env: { PATH: overlay.env.PATH },
      });
      expect(result.error).toBeUndefined();
      expect(result.stdout.trim()).toBe("SYSTEM");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("isPathWithin normalizes both operands before comparing", () => {
    const cases: Array<[string, string[], boolean]> = [
      ["/tmp/bun", ["/tmp/bun"], true],
      // A trailing slash on either side must not change the answer.
      ["/tmp/bun/", ["/tmp/bun"], true],
      ["/tmp/bun", ["/tmp/bun/"], true],
      ["/tmp/bun/.", ["/tmp/bun"], true],
      ["/tmp/bun/sub/../file", ["/tmp/bun"], true],
      // Traversal out of the granted root is not "within" it.
      ["/tmp/bun/../../../home/u/.bun", ["/tmp/bun"], false],
      // Component boundaries, not string prefixes.
      ["/tmp/bunny", ["/tmp/bun"], false],
      ["/tmp/bun2", ["/tmp/bun/"], false],
      ["/tmp/bun", [""], false],
    ];
    for (const [path, roots, expected] of cases) {
      expect(isPathWithin(path, roots), `${path} in ${JSON.stringify(roots)}`).toBe(expected);
    }
  });

  test("isPathWithin canonicalizes symlinks and rejects relative paths", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-realpath-"));
    try {
      const writable = join(root, "work");
      const readonly = join(root, "readonly-bun");
      const realWork = join(root, "real-work");
      const workLink = join(root, "work-link");
      mkdirSync(writable);
      mkdirSync(readonly);
      mkdirSync(realWork);
      symlinkSync(readonly, join(writable, ".bun"));
      symlinkSync(realWork, workLink);

      // A link inside a granted root that points outside it is not writable;
      // the sandbox enforces grants on the canonical target.
      expect(isPathWithin(join(writable, ".bun"), [writable])).toBe(false);
      expect(isPathWithin(readonly, [writable])).toBe(false);
      // A granted root that is itself a symlink matches its canonical target.
      expect(isPathWithin(join(realWork, "sub"), [workLink])).toBe(true);
      // A path that does not exist yet is still writable through its parent.
      expect(isPathWithin(join(writable, "new", "dir"), [writable])).toBe(true);
      // Relative values depend on the child cwd, so they are never trusted.
      expect(isPathWithin(".bun", [writable])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("redirects a configured BUN_INSTALL that is a symlink outside the grant", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-symlink-overlay-"));
    try {
      const writable = join(root, "work");
      const readonly = join(root, "readonly-bun");
      mkdirSync(writable);
      mkdirSync(readonly);
      const link = join(writable, ".bun");
      symlinkSync(readonly, link);

      const bun = sandboxBunEnv(join(root, "cache"));
      const overlay = bunSandboxOverlay(bun, [writable], {
        BUN_INSTALL: link,
        BUN_TMPDIR: join(writable, "bun-tmp"),
        PATH: "/usr/bin:/bin",
      });
      // The symlinked install points outside the grant, so it is redirected;
      // the tmp dir is a real path inside the grant and is preserved.
      expect(overlay.env.BUN_INSTALL).toBe(bun.env.BUN_INSTALL);
      expect(overlay.env.BUN_TMPDIR).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evicts a cache root that has been idle past the threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-evict-"));
    const base = join(root, "cache");
    try {
      const first = sandboxBunEnv(base);
      const stale = join(first.env.BUN_INSTALL, "stale-package");
      writeFileSync(stale, "old");
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      utimesSync(join(base, ".last-used"), old, old);

      const second = sandboxBunEnv(base);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(second.env.BUN_INSTALL)).toBe(true);
      expect(statSync(second.env.BUN_INSTALL).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sweeps stale workspace roots that are not the one being resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-sweep-"));
    const base = join(root, "cache");
    try {
      const a = sandboxBunEnv(base, "/repos/a");
      const b = sandboxBunEnv(base, "/repos/b");
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      utimesSync(join(a.writablePath, ".last-used"), old, old);

      // Resolving B must also discard A's abandoned root.
      sandboxBunEnv(base, "/repos/b");
      expect(existsSync(a.writablePath)).toBe(false);
      expect(existsSync(b.writablePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prunes stale BUN_TMPDIR entries while keeping fresh ones", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-env-tmp-prune-"));
    const base = join(root, "cache");
    try {
      const bun = sandboxBunEnv(base);
      const stale = join(bun.env.BUN_TMPDIR, "stale");
      const fresh = join(bun.env.BUN_TMPDIR, "fresh");
      writeFileSync(stale, "");
      writeFileSync(fresh, "");
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      utimesSync(stale, old, old);

      sandboxBunEnv(base);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("NonoSandboxProvider harness state grants", () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    // A temporary HOME makes the grant set deterministic: the provider skips
    // state dirs that do not exist on this machine.
    home = mkdtempSync(join(tmpdir(), "nono-home-"));
    process.env.HOME = home;
    delete process.env.AGENT_SANDBOX_NONO_PROFILE;
    resetNonoPackState();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    resetNonoPackState();
  });

  /** The paths the provider grants read+write access to. */
  function allows(wrapped: { args: string[] }): string[] {
    const sep = wrapped.args.indexOf("--");
    const out: string[] = [];
    for (let i = 0; i < sep; i++) {
      if (wrapped.args[i] === "--allow") out.push(wrapped.args[i + 1] as string);
    }
    return out;
  }

  function wrap(harnessName: string, cli = `/usr/local/bin/${harnessName}`) {
    return new NonoSandboxProvider().wrapCommand(cli, ["-p", "hi"], policy({ harnessName }));
  }

  test("grants grok write access to ~/.grok (auth, sessions and logs)", () => {
    mkdirSync(join(home, ".grok"), { recursive: true });
    expect(allows(wrap("grok"))).toContain(join(home, ".grok"));
  });

  test("never grants write access to toolchain dirs such as mise", () => {
    mkdirSync(join(home, ".local/share/mise"), { recursive: true });
    mkdirSync(join(home, ".grok"), { recursive: true });
    const grants = allows(wrap("grok"));
    expect(grants).not.toContain(join(home, ".local/share/mise"));
    expect(grants).not.toContain(join(home, ".local"));
    expect(grants).not.toContain(join(home, ".local/share"));
  });

  test("grants a newly declared harness state dir (qwen → ~/.qwen)", () => {
    mkdirSync(join(home, ".qwen"), { recursive: true });
    expect(allows(wrap("qwen"))).toContain(join(home, ".qwen"));
  });

  test("keeps the existing claude-code, codex and opencode grants", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".config/opencode"), { recursive: true });
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(home, ".local/state/opencode"), { recursive: true });

    expect(allows(wrap("claude-code"))).toContain(join(home, ".claude"));
    expect(allows(wrap("codex"))).toContain(join(home, ".codex"));
    const opencode = allows(wrap("opencode"));
    expect(opencode).toContain(join(home, ".config/opencode"));
    expect(opencode).toContain(join(home, ".local/share/opencode"));
    expect(opencode).toContain(join(home, ".local/state/opencode"));
    expect(opencode).not.toContain(join(home, ".local/state"));
  });

  test("grants the XDG state dirs of XDG-based harnesses (goose, kilo-code)", () => {
    mkdirSync(join(home, ".config/goose"), { recursive: true });
    mkdirSync(join(home, ".local/share/goose"), { recursive: true });
    mkdirSync(join(home, ".config/kilo"), { recursive: true });
    mkdirSync(join(home, ".cache/kilo"), { recursive: true });

    const goose = allows(wrap("goose"));
    expect(goose).toContain(join(home, ".config/goose"));
    expect(goose).toContain(join(home, ".local/share/goose"));

    const kilo = allows(wrap("kilo-code"));
    expect(kilo).toContain(join(home, ".config/kilo"));
    expect(kilo).toContain(join(home, ".cache/kilo"));
  });
});

describe("nono pack profile status", () => {
  const originalHome = process.env.HOME;
  let tempHome: string;
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "nono-pack-home-"));
    process.env.HOME = tempHome;
    resetNonoPackState();
    delete process.env.AGENT_SANDBOX_NONO_PROFILE;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
    resetNonoPackState();
    nonoPackInstalled = true;
  });

  test("a harness without a pack reports the generic fallback and its state dirs", () => {
    const status = describeNonoPack("grok");
    expect(status.packBacked).toBe(false);
    expect(status.note).toBe(
      `nono has no pack profile for "grok"; using ` +
        `${process.platform === "linux" ? "linux-host-compat" : "nono's default profile"} ` +
        "+ explicit grants (state: ~/.grok).",
    );
  });

  test("a pack-backed harness reports no fallback note", () => {
    nonoPackInstalled = true;
    const status = describeNonoPack("opencode");
    expect(status.packBacked).toBe(true);
    expect(status.profile).toBe("opencode");
    expect(status.note).toBeUndefined();
  });

  test("a known but uninstalled pack is named in the note", () => {
    nonoPackInstalled = false;
    const status = describeNonoPack("codex");
    expect(status.packBacked).toBe(false);
    expect(status.note).toContain('nono pack profile "codex" is not installed');
  });

  test("the missing-pack note is logged once per process, not per spawn", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      new NonoSandboxProvider().wrapCommand(
        "/usr/local/bin/grok",
        [],
        policy({ harnessName: "grok" }),
      );
      new NonoSandboxProvider().wrapCommand(
        "/usr/local/bin/grok",
        [],
        policy({ harnessName: "grok" }),
      );
    } finally {
      console.warn = originalWarn;
    }
    const notes = warnings.filter((w) => w.includes('no pack profile for "grok"'));
    expect(notes).toHaveLength(1);
  });

  test("no note is logged for a pack-backed harness", () => {
    nonoPackInstalled = true;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      new NonoSandboxProvider().wrapCommand(
        "/usr/local/bin/opencode",
        [],
        policy({ harnessName: "opencode" }),
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.filter((w) => w.includes("pack profile"))).toHaveLength(0);
  });

  test("no note is logged when the user supplies their own nono profile", () => {
    process.env.AGENT_SANDBOX_NONO_PROFILE = "my-profile";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      new NonoSandboxProvider().wrapCommand(
        "/usr/local/bin/grok",
        [],
        policy({ harnessName: "grok" }),
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.filter((w) => w.includes("pack profile"))).toHaveLength(0);
  });
});

describe("nono Landlock grant refinement", () => {
  test("parseDenyOverlaps extracts the protected paths from a refusal", () => {
    const stderr = [
      "nono: Sandbox initialization failed: Landlock deny-overlap is not enforceable on Linux.",
      "- deny '/home/u/.config/chromium' overlaps allowed parent '/home/u/.config' (source: user)",
      "- deny '/home/u/.config/bun/bunfig.toml' overlaps allowed parent '/home/u/.config' (source: user)",
      "- ... and 5 more conflict(s)",
    ].join("\n");
    expect(parseDenyOverlaps(stderr)).toEqual([
      "/home/u/.config/chromium",
      "/home/u/.config/bun/bunfig.toml",
    ]);
  });

  test("refineGrantsAgainstDenies expands a conflicting parent into children minus denied subtrees", () => {
    const root = mkdtempSync(join(tmpdir(), "nono-refine-"));
    mkdirSync(join(root, "chromium"));
    mkdirSync(join(root, "git"));
    mkdirSync(join(root, "bun"));
    writeFileSync(join(root, "bun", "bunfig.toml"), "");
    writeFileSync(join(root, "bun", "install.lock"), "");
    writeFileSync(join(root, "starship.toml"), "");

    const refined = refineGrantsAgainstDenies(
      [{ flag: "--read", path: root }],
      [join(root, "chromium"), join(root, "bun", "bunfig.toml")],
    );
    const paths = refined.map((g) => `${g.flag} ${g.path}`).sort();
    expect(paths).toEqual(
      [
        // denied dir skipped; dir containing a denied file expanded one level
        `--read ${join(root, "git")}`,
        `--read-file ${join(root, "bun", "install.lock")}`,
        `--read-file ${join(root, "starship.toml")}`,
      ].sort(),
    );
  });

  test("refineGrantsAgainstDenies grants symlinks according to their targets", () => {
    const root = mkdtempSync(join(tmpdir(), "nono-symlinks-"));
    const targetDir = join(root, "target-dir");
    const targetFile = join(root, "target-file");
    mkdirSync(targetDir);
    mkdirSync(join(root, "denied"));
    writeFileSync(targetFile, "test");
    symlinkSync(targetDir, join(root, "directory-link"));
    symlinkSync(targetFile, join(root, "file-link"));
    symlinkSync(join(root, "missing"), join(root, "broken-link"));

    const refined = refineGrantsAgainstDenies(
      [{ flag: "--read", path: root }],
      [join(root, "denied")],
    );
    expect(refined).toContainEqual({ flag: "--read", path: join(root, "directory-link") });
    expect(refined).toContainEqual({ flag: "--read-file", path: join(root, "file-link") });
    expect(refined.some((grant) => grant.path === join(root, "broken-link"))).toBe(false);
  });

  test("refineGrantsAgainstDenies leaves unrelated and non-directory grants unchanged", () => {
    const grants = [
      { flag: "--allow", path: "/work/repo" },
      { flag: "--read-file", path: "/home/u/.gitconfig" },
    ] as const;
    expect(refineGrantsAgainstDenies(grants, ["/home/u/.config/chromium"])).toEqual([...grants]);
  });
});

/** Records create/policy calls instead of spawning a real microVM. */
class StubDockerProvider extends DockerSandboxProvider {
  createCalls: Array<{ sbxAgent: string; sandboxName: string; workingDir: string }> = [];
  policyCalls: Array<{ sandboxName: string; policy: SandboxPolicy }> = [];
  protected override createSandbox(sbxAgent: string, sandboxName: string, workingDir: string) {
    this.createCalls.push({ sbxAgent, sandboxName, workingDir });
  }
  protected override applyNetworkPolicy(sandboxName: string, p: SandboxPolicy) {
    this.policyCalls.push({ sandboxName, policy: p });
  }
}

describe("DockerSandboxProvider.wrapCommand", () => {
  test("creates a named sandbox, applies policy, then execs the agent", () => {
    const provider = new StubDockerProvider();
    const wrapped = provider.wrapCommand(
      "/usr/bin/claude",
      ["--max-turns", "5"],
      policy({ workingDir: "/Users/dev/repo" }),
    );
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0]?.sbxAgent).toBe("claude");
    expect(provider.createCalls[0]?.sandboxName).toStartWith("devintern-");
    expect(provider.createCalls[0]?.workingDir).toBe("/Users/dev/repo");
    expect(provider.policyCalls).toHaveLength(1);
    expect(provider.policyCalls[0]?.sandboxName).toBe(provider.createCalls[0]!.sandboxName);

    expect(wrapped.path).toBe("sbx");
    // Exec against the created sandbox; agent argv follows the -- separator.
    expect(wrapped.args).toEqual([
      "exec",
      provider.createCalls[0]!.sandboxName,
      "--",
      "claude",
      "--max-turns",
      "5",
    ]);
    expect(typeof wrapped.cleanup).toBe("function");
  });

  test("rejects unsupported harnesses", () => {
    expect(() =>
      new DockerSandboxProvider().wrapCommand(
        "/usr/bin/goose",
        [],
        policy({ workingDir: "/Users/dev/repo", harnessName: "goose" }),
      ),
    ).toThrow("does not support");
  });

  test("rejects working directories under /tmp (not synced into the VM)", () => {
    expect(() =>
      new DockerSandboxProvider().wrapCommand(
        "/usr/bin/claude",
        [],
        policy({ workingDir: "/tmp/devintern-review-worktree-x" }),
      ),
    ).toThrow("cannot sync");
  });

  test("supportsHarness reflects the allowlist", () => {
    const provider = new DockerSandboxProvider();
    expect(provider.supportsHarness("claude-code")).toBe(true);
    expect(provider.supportsHarness("codex")).toBe(true);
    expect(provider.supportsHarness("goose")).toBe(false);
  });
});
