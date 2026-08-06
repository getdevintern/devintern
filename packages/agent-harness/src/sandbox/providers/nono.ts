/**
 * nono sandbox provider.
 *
 * nono (https://nono.sh, github.com/always-further/nono) applies kernel-level
 * restrictions (Landlock on Linux, Seatbelt on macOS) and then execs the
 * wrapped command in place, so the agent remains the process-group leader and
 * the reaper in `process-reaper.ts` works unchanged.
 *
 * CLI: nono run [flags] -- <command> [args...]
 *
 * nono's default profile opens system paths but confines $HOME to the working
 * directory, and it refuses any grant that overlaps its protected state root
 * (`~/.local/state/nono`), so a blanket `--read /` or `--read $HOME` is
 * rejected at startup. The policy therefore translates into explicit grants:
 *
 * - `--allow` for every policy writable path (working dir, task output dir,
 *   tmpdir, browser caches).
 * - v1 "reads stay open": `--read` for each top-level $HOME entry, skipping
 *   `.local` (the state-root conflict) and re-granting `.local/share` +
 *   `.local/bin` beneath it.
 * - `--allow` on the harness's own config dir (e.g. `~/.claude` +
 *   `~/.claude.json`): agents write session state there and hard-fail
 *   without it.
 * - `--allow-file /dev/ptmx` so tools that allocate a PTY (lefthook,
 *   script(1), interactive CLIs) can open the master; without it git
 *   hooks fail with path_not_granted on /dev/ptmx.
 * - `--allow-unix-socket $SSH_AUTH_SOCK` so `git push` over ssh works.
 * - Domain allowlists map to repeated `--allow-domain` (nono's proxy filter);
 *   network is otherwise open by default.
 *
 * `AGENT_SANDBOX_NONO_PROFILE` still selects a nono profile (`--profile`);
 * the explicit grants compose on top of it.
 *
 * Linux: Landlock cannot express "deny under an allowed parent", so nono
 * refuses to start when a broad grant contains one of its protected paths
 * (browser profiles, cloud credentials — the set is machine-dependent, e.g.
 * `~/.config/chromium` only when Chromium is installed). The provider
 * therefore preflights `nono run <grants> -- true` and, on a deny-overlap
 * refusal, replaces each conflicting broad grant with grants for its
 * children minus the denied subtrees, repeating until nono accepts the
 * policy. macOS (Seatbelt expresses deny-over-allow natively) is unaffected.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { findInPath } from "../../resolver.js";
import { probeCommand, unsupportedPlatform } from "../probe.js";
import type { SandboxDetection, SandboxPolicy, SandboxProvider, WrappedCommand } from "../types.js";

/** Harness name → $HOME config paths the agent needs read+write access to. */
const HARNESS_STATE_PATHS: Record<string, string[]> = {
  "claude-code": [".claude", ".claude.json"],
  codex: [".codex"],
  // agy keeps state under ~/.gemini (legacy Gemini CLI layout)
  antigravity: [".gemini"],
  gemini: [".gemini"],
  // cursor-agent writes chats under ~/.config/cursor; IDE state stays in ~/.cursor
  cursor: [".cursor", ".config/cursor"],
  opencode: [".config/opencode", ".local/share/opencode"],
};

/**
 * Harness name → nono registry pack profile name (used when installed).
 * Official packs live at registry.nono.sh under nolabs-ai/<agent>
 * (Sigstore-verified on pull): claude (installs profile claude-code),
 * codex, opencode, goose, pi, antigravity. No packs yet for cursor or
 * the other CLI harnesses.
 */
const HARNESS_NONO_PROFILES: Record<string, string> = {
  "claude-code": "claude-code",
  codex: "codex",
  opencode: "opencode",
  goose: "goose",
  pi: "pi",
  antigravity: "antigravity",
};

/**
 * Resolve the nono profile for a harness, when nono has one installed.
 *
 * The claude-code profile (pack `nolabs-ai/claude`) carries grants a plain
 * flag set cannot express on macOS — Keychain access and Seatbelt extras —
 * without which the agent starts logged-out. Probed once per process.
 */
const profileProbeCache = new Map<string, string | undefined>();
function builtinProfileFor(harnessName: string): string | undefined {
  if (profileProbeCache.has(harnessName)) return profileProbeCache.get(harnessName);
  const candidate = HARNESS_NONO_PROFILES[harnessName];
  const resolved =
    candidate && probeCommand("nono", ["profile", "show", candidate]) !== null
      ? candidate
      : undefined;
  profileProbeCache.set(harnessName, resolved);
  return resolved;
}

/** A single filesystem grant flag for `nono run`. */
export interface NonoGrant {
  flag: "--allow" | "--allow-file" | "--read" | "--read-file";
  path: string;
}

const DIR_TO_FILE_FLAG = { "--allow": "--allow-file", "--read": "--read-file" } as const;

/** How deep a conflicting directory grant is expanded before giving up. */
const MAX_EXPAND_DEPTH = 3;
/** nono reports at most 5 conflicts per refusal, so refinement iterates. */
const MAX_PREFLIGHT_ROUNDS = 8;

const DENY_OVERLAP_RE = /deny '([^']+)' overlaps allowed parent '([^']+)'/g;

/** Extract the protected paths named in a nono deny-overlap refusal. */
export function parseDenyOverlaps(output: string): string[] {
  return [...output.matchAll(DENY_OVERLAP_RE)].map((m) => m[1] as string);
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(`${parent}/`);
}

function expandDirGrant(
  flag: "--allow" | "--read",
  dirPath: string,
  denies: readonly string[],
  depth: number,
): NonoGrant[] {
  if (depth >= MAX_EXPAND_DEPTH) return [];
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: NonoGrant[] = [];
  for (const entry of entries) {
    const p = join(dirPath, entry.name);
    if (denies.includes(p)) continue;
    if (denies.some((d) => isInside(d, p))) {
      if (entry.isDirectory()) out.push(...expandDirGrant(flag, p, denies, depth + 1));
      continue;
    }
    out.push(entry.isDirectory() ? { flag, path: p } : { flag: DIR_TO_FILE_FLAG[flag], path: p });
  }
  return out;
}

/**
 * Replace every directory grant that contains a known denied path with
 * grants for its children, excluding the denied subtrees. Grants without a
 * conflict pass through unchanged (nono accepts grants at or below a deny —
 * the refusal is specific to broad parents).
 */
export function refineGrantsAgainstDenies(
  grants: readonly NonoGrant[],
  denies: readonly string[],
): NonoGrant[] {
  const out: NonoGrant[] = [];
  for (const grant of grants) {
    if (
      (grant.flag === "--allow" || grant.flag === "--read") &&
      denies.some((d) => isInside(d, grant.path))
    ) {
      out.push(...expandDirGrant(grant.flag, grant.path, denies, 0));
    } else {
      out.push(grant);
    }
  }
  return out;
}

function flattenGrants(grants: readonly NonoGrant[]): string[] {
  return grants.flatMap((g) => [g.flag, g.path]);
}

/**
 * Linux: nono's default profile blocks system reads (/etc, /sys, /run),
 * which breaks the v1 "reads stay open" policy in practice — ssh cannot
 * resolve uids without /etc/passwd, and Chromium needs /etc/fonts + sysfs.
 * Profiles are nono's documented composition mechanism (`--profile` is not
 * repeatable, but a profile file can extend several bases: list fields
 * merge, rightmost base wins single-value conflicts). So generate a profile
 * extending the built-in linux-host-compat (runtime state, sysfs, /tmp
 * reads) plus the harness pack profile when installed — last, so its
 * harness-specific settings win. /etc is granted here too: no built-in
 * group covers it (system_read_linux is libraries and locale data only).
 */
function linuxCompositeProfile(packProfile: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "devintern-nono-"));
  const file = join(dir, "profile.jsonc");
  const profile = {
    extends: ["linux-host-compat", ...(packProfile ? [packProfile] : [])],
    meta: {
      name: "devintern-linux",
      description: "DevIntern: Linux host compatibility plus the harness pack profile",
    },
    filesystem: { read: ["/etc"] },
  };
  writeFileSync(file, JSON.stringify(profile, null, 2));
  return file;
}

const preflightCache = new Map<string, NonoGrant[]>();

/**
 * Linux-only: dry-run the grant set (`nono run <grants> -- true`) and refine
 * it until nono accepts the policy. Non-conflict failures (nono missing, any
 * other startup error) return the grants unchanged so the real spawn
 * surfaces the actual error. Results are cached per process — long-lived
 * hosts pay the probe cost once per distinct grant set.
 */
function preflightLandlockGrants(
  prefix: readonly string[],
  grants: NonoGrant[],
  suffix: readonly string[],
): NonoGrant[] {
  if (process.platform !== "linux") return grants;
  const key = JSON.stringify([prefix, grants, suffix]);
  const cached = preflightCache.get(key);
  if (cached) return cached;

  let current = grants;
  const denies = new Set<string>();
  for (let round = 0; round < MAX_PREFLIGHT_ROUNDS; round++) {
    const result = spawnSync(
      "nono",
      [...prefix, ...flattenGrants(current), ...suffix, "--", "true"],
      { encoding: "utf8", stdio: "pipe", timeout: 15_000, env: process.env },
    );
    if (result.error || result.status === 0) break;
    const found = parseDenyOverlaps(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
    if (found.length === 0) break;
    for (const deny of found) denies.add(deny);
    const next = refineGrantsAgainstDenies(current, [...denies]);
    if (JSON.stringify(next) === JSON.stringify(current)) break;
    current = next;
  }
  preflightCache.set(key, current);
  return current;
}

export class NonoSandboxProvider implements SandboxProvider {
  readonly name = "nono";
  readonly displayName = "nono (kernel sandbox)";
  readonly priority = 30;
  readonly docsUrl = "https://nono.sh/docs";

  async detect(): Promise<SandboxDetection> {
    const platform = unsupportedPlatform();
    if (platform) return platform;

    const path = findInPath("nono");
    if (!path) {
      return {
        available: false,
        reason:
          "nono not found on PATH. Install: " +
          (process.platform === "linux"
            ? '"curl -fsSL https://nono.sh/install.sh | sh"'
            : '"brew install nono"') +
          " or see https://nono.sh",
      };
    }
    const version = probeCommand(path, ["--version"]) ?? undefined;
    // Surface the claude-code pack requirement at doctor time: without it,
    // claude-code runs on macOS start logged out (Keychain access lives in
    // the pack profile, not in flags).
    if (probeCommand(path, ["profile", "show", "claude-code"]) === null) {
      return {
        available: true,
        version: `${version ?? "installed"} — for claude-code runs, first install the Claude pack: "nono pull nolabs-ai/claude"`,
      };
    }
    return { available: true, version };
  }

  wrapCommand(path: string, args: readonly string[], policy: SandboxPolicy): WrappedCommand {
    const nonoArgs = ["run"];
    const harnessName = policy.harnessName ?? "claude-code";
    // An explicit AGENT_SANDBOX_NONO_PROFILE is respected verbatim (users can
    // multi-extend in their own profile file); otherwise Linux composes the
    // host-compat and pack profiles, macOS uses the pack profile directly.
    const envProfile = process.env.AGENT_SANDBOX_NONO_PROFILE;
    const packProfile = builtinProfileFor(harnessName);
    const profile =
      envProfile ??
      (process.platform === "linux" ? linuxCompositeProfile(packProfile) : packProfile);
    if (profile) {
      nonoArgs.push("--profile", profile);
    }

    const home = homedir();
    const grants: NonoGrant[] = [];

    // Read+write: the policy's writable set.
    const writable = new Set([policy.workingDir, ...policy.writablePaths]);
    for (const p of writable) {
      if (existsSync(p)) grants.push({ flag: "--allow", path: p });
    }

    // Read+write: the harness's own state (session files, settings). Without
    // this the agent exits at startup (observed with claude-code, which also
    // writes ~/.claude/projects during a run).
    for (const rel of HARNESS_STATE_PATHS[harnessName] ?? []) {
      const p = join(home, rel);
      if (!existsSync(p)) continue;
      grants.push({ flag: rel.endsWith(".json") ? "--allow-file" : "--allow", path: p });
    }

    // v1 policy keeps reads open. nono rejects any grant overlapping its
    // state root (~/.local/state/nono), so grant $HOME per top-level entry,
    // skip .local, and re-grant the safe subtrees beneath it.
    let entries: string[] = [];
    try {
      entries = readdirSync(home, { withFileTypes: true }).map((e) =>
        e.isDirectory() ? `${e.name}/` : e.name,
      );
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
      if (name === ".local") continue;
      grants.push({
        flag: entry.endsWith("/") ? "--read" : "--read-file",
        path: join(home, name),
      });
    }
    for (const rel of [".local/share", ".local/bin"]) {
      const p = join(home, rel);
      if (existsSync(p)) grants.push({ flag: "--read", path: p });
    }

    // Extra readable roots from the policy (parity with srt's allowRead).
    for (const p of policy.readablePaths ?? []) {
      if (existsSync(p)) grants.push({ flag: "--read", path: p });
    }

    // PTY master: lefthook (and similar) open /dev/ptmx per hook command.
    // Write-only is not enough — openpty needs O_RDWR (--allow-file).
    if (existsSync("/dev/ptmx")) {
      grants.push({ flag: "--allow-file", path: "/dev/ptmx" });
    }

    const suffix: string[] = [];

    // ssh-agent socket for git push over ssh.
    const sshAgentSocket = process.env.SSH_AUTH_SOCK;
    if (sshAgentSocket) {
      suffix.push("--allow-unix-socket", sshAgentSocket);
    }

    // Network: open by default in nono; a policy allowlist maps to the proxy
    // filter. (Programs that ignore proxy env vars lose connectivity when an
    // allowlist is set — same caveat as srt.)
    if (policy.network !== "open") {
      for (const domain of policy.network.allowedDomains) {
        suffix.push("--allow-domain", domain);
      }
    }

    const refined = preflightLandlockGrants(nonoArgs, grants, suffix);
    return {
      path: "nono",
      args: [...nonoArgs, ...flattenGrants(refined), ...suffix, "--", path, ...args],
    };
  }
}
