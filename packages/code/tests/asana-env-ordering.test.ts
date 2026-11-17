/**
 * Regression coverage for the Asana endpoint-override security invariant.
 *
 * `AsanaClient` snapshots `DEVINTERN_E2E_FAKE_ASANA`/`ASANA_API_BASE_URL` when
 * the module is evaluated, so a project `.env` loaded later cannot redirect a
 * real PAT. That only holds while the product imports the client before any
 * `.env` loader runs. The fixture below mirrors the CLI entry: it statically
 * imports the tracker package (as `src/index.ts:8` does, which re-exports the
 * Asana client) and only then calls `loadEnvironment()` (as `src/index.ts:136`
 * does in `main`). A lazy import would evaluate the client after the `.env`
 * and silently enable the redirect with every existing client test green.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const trackerIndexPath = join(repositoryRoot, "packages", "task-trackers", "src", "index.ts");
const asanaClientPath = join(
  repositoryRoot,
  "packages",
  "task-trackers",
  "src",
  "clients",
  "asana.ts",
);
const bootstrapPath = join(packageRoot, "src", "lib", "cli", "bootstrap.ts");

/** Fixture entry point that mirrors the CLI's import-then-load ordering. */
function fixtureScript(): string {
  return `
import { isMarkdownFilePath } from ${JSON.stringify(trackerIndexPath)};
import { loadEnvironment } from ${JSON.stringify(bootstrapPath)};

// src/index.ts:8 imports the tracker package statically, which evaluates
// asana.ts and freezes its environment snapshot before main() loads .env.
void isMarkdownFilePath;

const urls = [];
globalThis.fetch = async (input) => {
  urls.push(String(input));
  return new Response(JSON.stringify({ data: {} }), { status: 200 });
};

const envPath = loadEnvironment();

const { AsanaClient } = await import(${JSON.stringify(asanaClientPath)});
await new AsanaClient({ apiToken: "pat" }).getTaskDetail("123456");

// A second evaluation after .env proves the file would redirect a module that
// loaded late; if it cannot, the eager assertion below would be vacuous.
const { AsanaClient: LateClient } = await import(
  ${JSON.stringify(asanaClientPath)} + "?after-env"
);
await new LateClient({ apiToken: "pat" }).getTaskDetail("123456");

console.log(JSON.stringify({
  envPath,
  flag: process.env.DEVINTERN_E2E_FAKE_ASANA ?? null,
  baseUrl: process.env.ASANA_API_BASE_URL ?? null,
  eagerUrl: urls[0] ?? null,
  lateUrl: urls[1] ?? null,
}));
`;
}

interface FixtureResult {
  envPath: string | null;
  flag: string | null;
  baseUrl: string | null;
  eagerUrl: string | null;
  lateUrl: string | null;
}

describe("Asana endpoint override import ordering", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test("a project .env cannot redirect the eagerly imported Asana client", () => {
    root = mkdtempSync(join(tmpdir(), "asana-env-ordering-"));
    const home = join(root, "home");
    const project = join(root, "project");
    const configDir = join(project, ".devintern-code");
    mkdirSync(home, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    // Stop the upward .env walk at the fixture project.
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(
      join(configDir, ".env"),
      ["DEVINTERN_E2E_FAKE_ASANA=1", "ASANA_API_BASE_URL=http://127.0.0.1:54321/api/1.0", ""].join(
        "\n",
      ),
    );

    const fixturePath = join(root, "fixture.ts");
    writeFileSync(fixturePath, fixtureScript());

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      SENTRY_DISABLED: "1",
    };
    delete env.ASANA_API_BASE_URL;
    delete env.DEVINTERN_E2E_FAKE_ASANA;
    delete env.DEVINTERN_WORKER_SUBPROCESS;

    const result = spawnSync(process.execPath, [fixturePath], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);

    const parsed = JSON.parse(result.stdout.trim()) as FixtureResult;
    // The loader did apply the project `.env`...
    expect(parsed.envPath).toBe(join(configDir, ".env"));
    expect(parsed.flag).toBe("1");
    expect(parsed.baseUrl).toBe("http://127.0.0.1:54321/api/1.0");
    // ...and a client evaluated after it would have honored the redirect...
    expect(parsed.lateUrl).toStartWith("http://127.0.0.1:54321/api/1.0/tasks/123456?opt_fields=");
    // ...but the eagerly imported client froze the production endpoint first.
    expect(parsed.eagerUrl).toStartWith("https://app.asana.com/api/1.0/tasks/123456?opt_fields=");
  }, 30_000);
});
