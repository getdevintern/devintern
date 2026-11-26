/**
 * `devintern worker connect`: argument validation and the Sentry target,
 * fully offline.
 *
 * The built CLI runs against a temp workspace created through the real
 * `worker scaffold` + `worker add-repo` path. Relay and API base URLs point at
 * a loopback recorder that must see zero requests; Sentry is the in-process
 * `FakeSentryServer`. Sentry connect is interactive and refuses non-TTY stdin,
 * so the happy path is driven through a Bun pseudo-terminal rather than by
 * importing internals to bypass the TTY check.
 *
 * Relay targets (`github`, `gitlab`, tracker webhooks, `status`) need a
 * signed-in relay session and stay in the live/opt-in suites.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { cliPath } from "../../helpers/fixture-workspace";
import { checkedCommand, command } from "../../helpers/process";
import type { CommandResult } from "../../helpers/process";
import { FakeSentryServer } from "../../providers/fake-sentry";

const cliTest = test.skipIf(!existsSync(cliPath));

/**
 * Bun >= 1.3.5 spawns children on a pseudo-terminal (`Bun.spawn({ terminal })`).
 * The repo pins Bun 1.4, so this only skips on platforms without PTY support
 * (Windows), where the interactive Sentry flow cannot be exercised end to end.
 */
const ptyAvailable = typeof Bun.Terminal === "function" && process.platform !== "win32";
if (!ptyAvailable) {
  console.warn(
    "worker-connect: skipping interactive Sentry connect cases; Bun pseudo-terminal support is unavailable on this platform.",
  );
}
const ptyTest = test.skipIf(!existsSync(cliPath) || !ptyAvailable);

// Dedicated fixture credentials: never real, and never printed by assertions.
const FIXTURE_TOKEN = "e2e-sentry-fixture-token-7f3a9c";
const BAD_TOKEN = "e2e-sentry-rejected-token-0b41d2";
const ORG = "e2e-org";
const PROJECT = "e2e-project";

const WORKER_CONNECT_TARGETS = [
  "github",
  "gitlab",
  "linear",
  "asana",
  "trello",
  "azure-devops",
  "jira",
  "sentry",
  "status",
];

/** Loopback HTTP server that records every request it receives. */
class RequestRecorder {
  readonly requests: string[] = [];
  private readonly server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      this.requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("unexpected request in offline worker-connect test", { status: 500 });
    },
  });

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

interface SeededRepository {
  remoteDir: string;
  repoDir: string;
  repoName: string;
}

/** One test's isolated workspace plus every resource it owns. */
class ConnectFixture {
  readonly root = mkdtempSync(join(tmpdir(), "devintern-e2e-worker-connect-"));
  readonly recorder = new RequestRecorder();
  readonly env: Record<string, string>;
  readonly workspaceDir: string;
  readonly configPath: string;
  readonly envPath: string;
  private readonly releases: Array<() => void | Promise<void>> = [];

  constructor() {
    this.own(() => rmSync(this.root, { recursive: true, force: true }));
    this.own(() => this.recorder.stop());
    this.env = {
      ...isolatedEnvironment(this.root),
      WORKER_RELAY_URL: this.recorder.url,
      DEVINTERN_API_BASE: this.recorder.url,
    };
    this.workspaceDir = this.env.DEVINTERN_WORKSPACE_DIR!;
    this.configPath = join(this.workspaceDir, "workspace.toml");
    this.envPath = join(this.workspaceDir, ".env");
  }

  /** Record a cleanup step; steps run in reverse order of registration. */
  own(release: () => void | Promise<void>): void {
    this.releases.push(release);
  }

  /** Start a fake Sentry owned by this fixture. */
  sentry(options: ConstructorParameters<typeof FakeSentryServer>[0] = {}): FakeSentryServer {
    const sentry = new FakeSentryServer({ organization: ORG, project: PROJECT, ...options });
    this.own(() => sentry.stop());
    return sentry;
  }

  /** Release every owned resource, attempting all steps even if one fails. */
  async release(): Promise<void> {
    const errors: unknown[] = [];
    for (const release of [...this.releases].reverse()) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "worker-connect cleanup failed");
  }

  run(args: string[], cwd: string = this.root): Promise<CommandResult> {
    return command([process.execPath, cliPath, ...args], cwd, this.env);
  }

  /** `worker scaffold` plus one `worker add-repo` per name: the documented bootstrap path. */
  async bootstrap(repoNames: string[] = ["acme-app"]): Promise<SeededRepository[]> {
    const scaffold = await this.run(["worker", "scaffold"]);
    expect(scaffold.exitCode, scaffold.stderr).toBe(0);
    const repos: SeededRepository[] = [];
    for (const name of repoNames) {
      const repo = await this.seedRepository(name);
      const added = await this.run(["worker", "add-repo"], repo.repoDir);
      expect(added.exitCode, added.stderr).toBe(0);
      repos.push(repo);
    }
    const configured = (Bun.TOML.parse(readFileSync(this.configPath, "utf8")) as WorkspaceToml)
      .repos;
    expect(configured?.map((repo) => repo.name)).toEqual(repoNames);
    return repos;
  }

  /** Bare remote plus a checkout whose origin points at it. */
  private async seedRepository(name: string): Promise<SeededRepository> {
    const remoteDir = join(this.root, "remotes", `${name}.git`);
    mkdirSync(dirname(remoteDir), { recursive: true });
    await checkedCommand(
      ["git", "init", "--bare", "--initial-branch", "main", remoteDir],
      this.root,
      this.env,
    );
    const repoDir = join(this.root, "checkouts", name);
    mkdirSync(repoDir, { recursive: true });
    await checkedCommand(["git", "init", "--initial-branch", "main"], repoDir, this.env);
    writeFileSync(join(repoDir, "README.md"), "# Fixture\n");
    await checkedCommand(["git", "add", "."], repoDir, this.env);
    await checkedCommand(["git", "commit", "-m", "Initial commit"], repoDir, this.env);
    await checkedCommand(["git", "remote", "add", "origin", remoteDir], repoDir, this.env);
    await checkedCommand(["git", "push", "--set-upstream", "origin", "main"], repoDir, this.env);
    return { remoteDir, repoDir, repoName: name };
  }

  /**
   * Hashes of workspace.toml and .env plus the file list under `env/`, the
   * only places Sentry connect writes. Compared before and after a command.
   */
  snapshot(): Record<string, string> {
    const hash = (path: string) =>
      existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
    const envDir = join(this.workspaceDir, "env");
    return {
      "workspace.toml": hash(this.configPath),
      ".env": hash(this.envPath),
      "env/": existsSync(envDir) ? readdirSync(envDir).sort().join(",") : "absent",
    };
  }

  errorMonitors(): ErrorMonitorToml[] {
    const parsed = Bun.TOML.parse(readFileSync(this.configPath, "utf8")) as WorkspaceToml;
    return parsed.error_monitors ?? [];
  }

  /**
   * Run the CLI on a pseudo-terminal, answering each prompt once it appears.
   * PTY output merges stdout and stderr; ANSI sequences are stripped.
   */
  async runInTerminal(
    args: string[],
    answers: Array<[prompt: string, answer: string]>,
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{ exitCode: number; output: string }> {
    let raw = "";
    const decoder = new TextDecoder();
    const child = Bun.spawn([process.execPath, cliPath, ...args], {
      cwd: options.cwd ?? this.root,
      env: { ...this.env, ...options.env },
      terminal: {
        cols: 200,
        rows: 50,
        data: (_terminal, data) => {
          raw += decoder.decode(data, { stream: true });
        },
      },
    });
    this.own(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.terminal?.close();
    });

    const deadline = Date.now() + 60_000;
    let consumed = 0;
    for (const [prompt, answer] of answers) {
      for (;;) {
        const index = stripAnsi(raw).indexOf(prompt, consumed);
        if (index !== -1) {
          consumed = index + prompt.length;
          break;
        }
        if (child.exitCode !== null || Date.now() > deadline) {
          // The transcript never contains a credential at this point unless
          // the CLI echoed one, which is itself the failure being reported.
          throw new Error(
            `Prompt "${prompt}" never appeared (exit ${child.exitCode}).\n${redact(stripAnsi(raw))}`,
          );
        }
        await Bun.sleep(20);
      }
      child.terminal!.write(`${answer}\r`);
    }

    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(Math.max(deadline - Date.now(), 1)).then(() => {
        child.kill("SIGKILL");
        throw new Error(`worker connect did not exit.\n${redact(stripAnsi(raw))}`);
      }),
    ]);
    // Let the PTY drain the final lines written just before exit.
    await Bun.sleep(100);
    child.terminal?.close();
    return { exitCode, output: stripAnsi(raw) };
  }
}

interface WorkspaceToml {
  repos?: Array<{ name: string; remote: string }>;
  error_monitors?: ErrorMonitorToml[];
}

interface ErrorMonitorToml {
  id: string;
  provider: string;
  repo: string;
  organization: string;
  project: string;
  base_url?: string;
  query?: string;
  env_file: string;
}

function stripAnsi(value: string): string {
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences are the input here
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "").replace(/\r/g, "");
}

function redact(value: string): string {
  return value.replaceAll(FIXTURE_TOKEN, "[fixture-token]").replaceAll(BAD_TOKEN, "[bad-token]");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Prompts in `runWorkerSentrySetup` order, answered for the fake. */
function sentryAnswers(
  sentry: FakeSentryServer,
  token?: string,
): Array<[prompt: string, answer: string]> {
  const answers: Array<[string, string]> = [
    ["Sentry URL [https://sentry.io]: ", sentry.url],
    ["Sentry organization slug: ", ORG],
    ["Sentry project slug: ", PROJECT],
    ["Sentry search filter (optional, e.g. environment:production): ", ""],
  ];
  if (token !== undefined) answers.push(["Sentry auth token (input hidden): ", token]);
  return answers;
}

const validationCases: Array<{
  name: string;
  args: (fixture: ConnectFixture) => string[];
  error: string;
}> = [
  {
    name: "unsupported target",
    args: () => ["bogus"],
    error:
      "Unsupported connect target 'bogus'. Available: github, gitlab, linear, asana, trello, azure-devops, jira, sentry, status.",
  },
  {
    name: "--team with status",
    args: () => ["status", "--team", "eng"],
    error: "--team is only valid for tracker connect targets.",
  },
  {
    name: "--team with sentry",
    args: () => ["sentry", "--team", "eng"],
    error: "--team is only valid for tracker connect targets.",
  },
  {
    name: "--repo with a non-sentry target",
    args: () => ["github", "--repo", "acme-app"],
    error: "--repo is only valid for Sentry connect.",
  },
  {
    name: "--disconnect with a non-gitlab target",
    args: () => ["linear", "--disconnect"],
    error: "--disconnect is only valid for the GitLab connect target.",
  },
  {
    name: "--workspace pointing at a missing file",
    args: (fixture) => ["status", "--workspace", join(fixture.root, "missing", "workspace.toml")],
    error: "", // Built per fixture below; the path is part of the message.
  },
];

for (const validation of validationCases) {
  cliTest(
    `worker connect rejects ${validation.name} without mutating the workspace or using the network`,
    async () => {
      const fixture = new ConnectFixture();
      try {
        await fixture.bootstrap();
        const before = fixture.snapshot();

        const args = validation.args(fixture);
        const result = await fixture.run(["worker", "connect", ...args]);
        const expectedError =
          validation.error ||
          `No workspace found at ${join(fixture.root, "missing", "workspace.toml")}. Run \`devintern worker init\` first.`;

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`❌ ${expectedError}`);
        expect(fixture.snapshot()).toEqual(before);
        expect(fixture.recorder.requests).toEqual([]);
      } finally {
        await fixture.release();
      }
    },
    60_000,
  );
}

cliTest(
  "worker connect --help lists every target without touching the network",
  async () => {
    const fixture = new ConnectFixture();
    try {
      const result = await fixture.run(["worker", "connect", "--help"]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage: devintern worker connect [target] [options]");
      for (const target of WORKER_CONNECT_TARGETS) {
        expect(result.stdout).toMatch(new RegExp(`^  ${target} +\\S`, "m"));
      }
      expect(fixture.recorder.requests).toEqual([]);
    } finally {
      await fixture.release();
    }
  },
  30_000,
);

cliTest(
  "worker connect sentry refuses non-TTY stdin and writes nothing",
  async () => {
    const fixture = new ConnectFixture();
    try {
      await fixture.bootstrap();
      const before = fixture.snapshot();
      const sentry = fixture.sentry();

      // `command` pipes stdout/stderr and gives the child no terminal stdin.
      const result = await fixture.run(["worker", "connect", "sentry"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "❌ 'devintern worker connect sentry' is interactive; run it in a terminal.",
      );
      expect(result.stdout).not.toContain("Sentry URL");
      expect(fixture.snapshot()).toEqual(before);
      expect(sentry.listRequests).toEqual([]);
      expect(fixture.recorder.requests).toEqual([]);
    } finally {
      await fixture.release();
    }
  },
  60_000,
);

ptyTest(
  "worker connect sentry validates against Sentry, writes one monitor plus a 0600 token file, and is idempotent",
  async () => {
    const fixture = new ConnectFixture();
    try {
      const [repo] = await fixture.bootstrap();
      const sentry = fixture.sentry({ expectedToken: FIXTURE_TOKEN });

      const first = await fixture.runInTerminal(
        ["worker", "connect", "sentry"],
        sentryAnswers(sentry, FIXTURE_TOKEN),
      );
      expect(first.exitCode, redact(first.output)).toBe(0);
      expect(first.output).toContain(
        `✅ Sentry access works: ${sentry.seededIssueCount} unresolved issue(s) currently match.`,
      );
      expect(sentry.unexpectedRequests).toEqual([]);
      expect(sentry.rejectedAuthCount).toBe(0);
      expect(sentry.listRequests).toHaveLength(1);
      expect(sentry.listRequests[0]).toMatchObject({
        organization: ORG,
        project: PROJECT,
        query: "is:unresolved",
      });
      expect(sentry.receivedBearer(FIXTURE_TOKEN)).toBe(true);

      const monitors = fixture.errorMonitors();
      expect(monitors).toHaveLength(1);
      expect(monitors[0]).toMatchObject({
        provider: "sentry",
        repo: repo!.repoName,
        organization: ORG,
        project: PROJECT,
        base_url: sentry.url,
      });
      const config = readFileSync(fixture.configPath, "utf8");
      expect(config.includes(FIXTURE_TOKEN)).toBe(false);
      expect(readFileSync(fixture.envPath, "utf8").includes(FIXTURE_TOKEN)).toBe(false);

      const tokenFile = join(fixture.workspaceDir, monitors[0]!.env_file);
      expect(first.output).toContain(`💾 Added [[error_monitors]] "${monitors[0]!.id}"`);
      expect(first.output).toContain(`🔐 Stored its token in ${tokenFile} (mode 0600).`);
      expect(existsSync(tokenFile)).toBe(true);
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(tokenFile, "utf8") === `SENTRY_AUTH_TOKEN=${FIXTURE_TOKEN}\n`).toBe(true);

      // The token prompt hides its input, and the CLI's own log lines must
      // not repeat it, so the token never appears in the merged transcript.
      expect(occurrences(first.output, FIXTURE_TOKEN)).toBe(0);
      expect(first.output.includes("Sentry auth token (input hidden): \n")).toBe(true);

      // Re-run with the token in the environment: no token prompt, no duplicate.
      const configBefore = fixture.snapshot();
      const second = await fixture.runInTerminal(
        ["worker", "connect", "sentry"],
        sentryAnswers(sentry),
        { env: { SENTRY_AUTH_TOKEN: FIXTURE_TOKEN } },
      );
      expect(second.exitCode, redact(second.output)).toBe(0);
      expect(second.output).toContain("Using SENTRY_AUTH_TOKEN from the existing environment.");
      expect(second.output).not.toContain("Sentry auth token (input hidden)");
      expect(second.output).toContain(
        `Sentry monitor "${monitors[0]!.id}" is already configured; no duplicate added.`,
      );
      expect(occurrences(second.output, FIXTURE_TOKEN)).toBe(0);
      expect(fixture.errorMonitors()).toHaveLength(1);
      expect(fixture.snapshot()).toEqual(configBefore);
      expect(sentry.listRequests).toHaveLength(2);
      expect(sentry.unexpectedRequests).toEqual([]);

      expect(fixture.recorder.requests).toEqual([]);
    } finally {
      await fixture.release();
    }
  },
  120_000,
);

ptyTest(
  "worker connect sentry fails closed when Sentry rejects the token",
  async () => {
    const fixture = new ConnectFixture();
    try {
      await fixture.bootstrap();
      const sentry = fixture.sentry({ expectedToken: FIXTURE_TOKEN });
      const before = fixture.snapshot();

      const result = await fixture.runInTerminal(
        ["worker", "connect", "sentry"],
        sentryAnswers(sentry, BAD_TOKEN),
      );

      expect(result.exitCode, redact(result.output)).toBe(1);
      expect(result.output).toContain("Sentry rejected the auth token (HTTP 401)");
      expect(result.output).toContain("No monitor or credential file was written.");
      expect(result.output).not.toContain("Sentry access works");
      expect(sentry.rejectedAuthCount).toBe(1);
      expect(sentry.unexpectedRequests).toEqual([]);
      expect(fixture.snapshot()).toEqual(before);
      expect(fixture.errorMonitors()).toEqual([]);
      // The prompt hides the typed token and the failure message must not repeat it.
      expect(occurrences(result.output, BAD_TOKEN)).toBe(0);
      expect(fixture.recorder.requests).toEqual([]);
    } finally {
      await fixture.release();
    }
  },
  120_000,
);

ptyTest(
  "worker connect sentry rejects an unknown --repo before prompting or writing",
  async () => {
    const fixture = new ConnectFixture();
    try {
      await fixture.bootstrap(["acme-app", "acme-api"]);
      const sentry = fixture.sentry();
      const before = fixture.snapshot();

      const result = await fixture.runInTerminal(
        ["worker", "connect", "sentry", "--repo", "acme-missing"],
        [],
      );

      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain('workspace repository "acme-missing" does not exist');
      expect(result.output).not.toContain("Sentry URL");
      expect(fixture.snapshot()).toEqual(before);
      expect(sentry.listRequests).toEqual([]);
      expect(fixture.recorder.requests).toEqual([]);
    } finally {
      await fixture.release();
    }
  },
  120_000,
);

ptyTest(
  "worker connect sentry attributes the monitor to the repo matching cwd's origin",
  async () => {
    const fixture = new ConnectFixture();
    try {
      const [, api] = await fixture.bootstrap(["acme-app", "acme-api"]);
      const sentry = fixture.sentry({ expectedToken: FIXTURE_TOKEN });

      const result = await fixture.runInTerminal(
        ["worker", "connect", "sentry"],
        sentryAnswers(sentry),
        { cwd: api!.repoDir, env: { SENTRY_AUTH_TOKEN: FIXTURE_TOKEN } },
      );

      expect(result.exitCode, redact(result.output)).toBe(0);
      // No repository prompt: cwd's origin resolved the ambiguity.
      expect(result.output).not.toContain("Repository for this Sentry project");
      const monitors = fixture.errorMonitors();
      expect(monitors).toHaveLength(1);
      expect(monitors[0]).toMatchObject({ repo: api!.repoName, project: PROJECT });
      expect(sentry.receivedBearer(FIXTURE_TOKEN)).toBe(true);
      expect(fixture.recorder.requests).toEqual([]);
    } finally {
      await fixture.release();
    }
  },
  120_000,
);
