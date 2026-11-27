/**
 * `bun run --filter @devintern/e2e test:e2e:golden-path`: the onboarding
 * golden path on a blank systemd box (see tests/golden-path/).
 *
 * DEVINTERN_CLI_SOURCE picks what gets installed in the container:
 *   - `source` (default): `bun pm pack` of the built packages/code CLI.
 *   - `npm:<version>` or `npm:latest`: `@getdevintern/code` from the npm
 *     registry, i.e. the release build (license bypass flags ignored).
 *   - `release-tarball:<path>`: a packed release build
 *     (`DEVINTERN_RELEASE_BUILD=1 bun run build`, then `bun pm pack`), checked
 *     like the npm release. For trying release-mode changes before publishing.
 *
 * Resolves the GitHub fixture repository and token (E2E_GITHUB_REPOSITORY,
 * E2E_GITHUB_TOKEN, or `gh auth token` locally) before any Docker work, so a
 * missing secret fails fast and never reaches the fixture repository.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliPath } from "../helpers/fixture-workspace";
import { resolveGitHubConfig } from "../helpers/github-config";
import { buildImage } from "../helpers/systemd-container";

const packageRoot = resolve(import.meta.dir, "..");
const codeRoot = resolve(packageRoot, "../code");
const GOLDEN_PATH_IMAGE = "devintern-e2e-golden-path:local";
const NPM_PACKAGE = "@getdevintern/code";

interface CliSource {
  /** What the suite installs with `bun add -g`. */
  install: { tarball: string } | { npmSpec: string };
  version: string;
  /** A release build, which ignores DEVINTERN_SKIP_LICENSE_CHECK. */
  release: boolean;
}

async function registryVersion(tag: string): Promise<string | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/${tag}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry: HTTP ${response.status} for ${tag}`);
  return ((await response.json()) as { version: string }).version;
}

/**
 * Resolve `npm:<version|latest>`. A just-published version can take a few
 * minutes to reach the registry, so an exact version is polled for up to
 * five minutes.
 */
async function npmSource(spec: string): Promise<CliSource> {
  const requested = spec.trim() || "latest";
  const deadline = Date.now() + 300_000;
  for (;;) {
    const version = await registryVersion(requested);
    if (version) {
      return { install: { npmSpec: `${NPM_PACKAGE}@${version}` }, version, release: true };
    }
    if (requested === "latest" || Date.now() >= deadline) {
      throw new Error(`${NPM_PACKAGE}@${requested} is not on the npm registry`);
    }
    console.log(`Waiting for ${NPM_PACKAGE}@${requested} to appear on the npm registry...`);
    await Bun.sleep(15_000);
  }
}

function packSource(destination: string): CliSource {
  if (!existsSync(cliPath)) {
    throw new Error("Build the CLI first: bun run --filter @getdevintern/code build");
  }
  // --ignore-scripts: pack the dist that was just built instead of rebuilding.
  const pack = Bun.spawnSync(
    [process.execPath, "pm", "pack", "--ignore-scripts", "--destination", destination, "--quiet"],
    { cwd: codeRoot, stdout: "pipe", stderr: "pipe" },
  );
  const tarball = readdirSync(destination).find((name) => name.endsWith(".tgz"));
  if (pack.exitCode !== 0 || !tarball) {
    throw new Error(`bun pm pack failed:\n${pack.stdout.toString()}${pack.stderr.toString()}`);
  }
  const version = (
    JSON.parse(readFileSync(join(codeRoot, "package.json"), "utf8")) as { version: string }
  ).version;
  return { install: { tarball: join(destination, tarball) }, version, release: false };
}

function releaseTarballSource(path: string): CliSource {
  const tarball = resolve(path);
  const manifest = Bun.spawnSync(["tar", "-xOzf", tarball, "package/package.json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (manifest.exitCode !== 0) {
    throw new Error(`Cannot read ${tarball}: ${manifest.stderr.toString()}`);
  }
  const { version } = JSON.parse(manifest.stdout.toString()) as { version: string };
  return { install: { tarball }, version, release: true };
}

async function resolveSource(setting: string, packDir: string): Promise<CliSource> {
  if (setting === "source") return packSource(packDir);
  if (setting.startsWith("npm:")) return npmSource(setting.slice("npm:".length));
  if (setting.startsWith("release-tarball:")) {
    return releaseTarballSource(setting.slice("release-tarball:".length));
  }
  throw new Error(
    'DEVINTERN_CLI_SOURCE must be "source", "npm:<version|latest>", or "release-tarball:<path>"',
  );
}

const github = await resolveGitHubConfig();
const docker = Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (docker.exitCode !== 0) {
  throw new Error("The golden path needs a running Docker daemon your user can access");
}

const packDir = mkdtempSync(join(tmpdir(), "devintern-e2e-golden-pack-"));
try {
  const source = await resolveSource(process.env.DEVINTERN_CLI_SOURCE?.trim() || "source", packDir);
  const label = "npmSpec" in source.install ? source.install.npmSpec : source.install.tarball;
  console.log(
    `Golden path: ${label} (v${source.version}, ${source.release ? "release" : "development"} build) against ${github.repository}`,
  );
  await buildImage(GOLDEN_PATH_IMAGE, {
    Dockerfile: "infrastructure/golden-path/Dockerfile",
    "fake-agent.ts": "helpers/fake-agent.ts",
    "simple-project": "fixtures/simple-project",
  });

  const child = Bun.spawn(
    [process.execPath, "test", "./tests/golden-path/golden-path.test.ts", "--timeout", "600000"],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        DEVINTERN_E2E_GOLDEN_PATH: "1",
        E2E_GOLDEN_IMAGE: GOLDEN_PATH_IMAGE,
        E2E_GOLDEN_CLI_VERSION: source.version,
        E2E_GOLDEN_RELEASE_BUILD: source.release ? "1" : "0",
        ...("tarball" in source.install
          ? { E2E_GOLDEN_CLI_TARBALL: source.install.tarball }
          : { E2E_GOLDEN_CLI_NPM_SPEC: source.install.npmSpec }),
        E2E_GITHUB_REPOSITORY: github.repository,
        E2E_GITHUB_TOKEN: github.token,
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await child.exited;
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
