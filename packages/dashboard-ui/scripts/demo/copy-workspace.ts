/**
 * Copy a real workspace into a throwaway one that holds only what may be
 * shown in the public demo: runs, pull requests, transcripts, and artifacts
 * of the allowlisted repositories, and a workspace.toml reduced to those
 * repositories and their automations. Serve the copy with `serve.ts` and
 * record it with `snapshot.ts --scrub` (`build-demo.sh --from-workspace`).
 *
 *   bun run scripts/demo/copy-workspace.ts --from ~/.devintern --to <dir> \
 *     --repo devintern --repo getdevintern/devintern [--db-path-as <path>]
 *
 * `--repo` matches a run's or PR's `repo` column (which holds the workspace
 * repo name or the host path) and a `[[repos]]` name. `--exclude-origin`
 * (default: error_monitor, whose issues can carry end-user data) drops runs
 * by origin; `--exclude-automation <id>` drops an automation's runs and its
 * config entry (e.g. `security-review`, whose reports can describe unfixed
 * vulnerabilities). `--db-path-as` is the path the server will open the copied
 * database at, since artifact files are stored under a hash of that path
 * (default: <to>/state/queue.db).
 *
 * Also writes `<to>/demo-deny.txt`: every other repository the source knows
 * (workspace names, remote paths, run and PR repo values), one per line, for
 * `snapshot.ts --deny`.
 *
 * The source is only read: its database is copied with `VACUUM INTO`.
 * Tracker teams, task queries, error monitors, routing rules, tracker
 * settings, env files, pipelines, queues, and cursors are never copied.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    repo: { type: "string", multiple: true, default: [] },
    "exclude-origin": { type: "string", multiple: true, default: ["error_monitor"] },
    "exclude-automation": { type: "string", multiple: true, default: [] },
    "db-path-as": { type: "string" },
  },
});
const from = flags.from;
const to = flags.to;
const repos = flags.repo;
if (!from || !to || repos.length === 0) {
  console.error("usage: copy-workspace.ts --from <workspace> --to <dir> --repo <name>...");
  process.exit(1);
}

/** Tables kept (filtered); every other table is emptied in the copy. */
const KEPT_TABLES = new Set([
  "runs",
  "run_stages",
  "run_artifacts",
  "run_artifact_uploads",
  "agent_prs",
  "automation_schedules",
  "sqlite_sequence",
]);

// ---------------------------------------------------------------------------
// workspace.toml
// ---------------------------------------------------------------------------

type Toml = Record<string, unknown>;
const source = Bun.TOML.parse(await Bun.file(join(from, "workspace.toml")).text()) as Toml;
const pick = (table: unknown, keys: readonly string[]): Toml =>
  Object.fromEntries(Object.entries((table ?? {}) as Toml).filter(([key]) => keys.includes(key)));
const omit = (table: Toml, keys: readonly string[]): Toml =>
  Object.fromEntries(Object.entries(table).filter(([key]) => !keys.includes(key)));

const keptRepos = ((source.repos ?? []) as Toml[])
  .filter((repo) => repos.includes(String(repo.name)))
  .map((repo) => omit(repo, ["env_file", "env", "pipeline_file"]));
const repoNames = new Set(keptRepos.map((repo) => String(repo.name)));
const keptAutomations = ((source.automations ?? []) as Toml[])
  .filter(
    (automation) =>
      repoNames.has(String(automation.repo)) &&
      !flags["exclude-automation"].includes(String(automation.id)),
  )
  .map((automation) => omit(automation, ["env_file", "env"]));

const config: Toml = {
  workspace: source.workspace ?? {},
  defaults: pick(source.defaults, ["tracker", "worker_task_args", "pr_labels", "dependency_mode"]),
  repos: keptRepos,
  automations: keptAutomations,
};

/** Minimal TOML writer for the parsed subset above (tables, arrays, scalars). */
function toToml(table: Toml, path: string[] = []): string {
  const scalar = (value: unknown): string =>
    Array.isArray(value) ? `[${value.map(scalar).join(", ")}]` : JSON.stringify(value);
  const isTable = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const isTableArray = (value: unknown) =>
    Array.isArray(value) && value.length > 0 && value.every(isTable);
  const lines: string[] = [];
  const nested: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (isTable(value)) {
      nested.push(`\n[${[...path, key].join(".")}]\n${toToml(value as Toml, [...path, key])}`);
    } else if (isTableArray(value)) {
      for (const entry of value as Toml[]) {
        nested.push(`\n[[${[...path, key].join(".")}]]\n${toToml(entry, [...path, key])}`);
      }
    } else if (!(Array.isArray(value) && value.length === 0 && path.length === 0)) {
      lines.push(`${key} = ${scalar(value)}`);
    }
  }
  return [...lines, ...nested].join("\n");
}

rmSync(to, { recursive: true, force: true });
mkdirSync(join(to, "state"), { recursive: true });
writeFileSync(
  join(to, "workspace.toml"),
  `# Demo copy: only ${[...repoNames].join(", ")} and its automations.\n${toToml(config)}\n`,
);

// ---------------------------------------------------------------------------
// queue.db
// ---------------------------------------------------------------------------

const sourceDb = join(from, "state", "queue.db");
const targetDb = join(to, "state", "queue.db");
const reader = new Database(sourceDb, { readonly: true });
reader.run(`VACUUM INTO '${targetDb.replace(/'/g, "''")}'`);
reader.close();

const remotePath = (remote: unknown): string | null =>
  /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(String(remote ?? ""))?.[1] ?? null;
const keptNames = new Set([...repos, ...keptRepos.map((repo) => remotePath(repo.remote))]);
const denied = new Set<string>();
for (const repo of (source.repos ?? []) as Toml[]) {
  if (repoNames.has(String(repo.name))) continue;
  denied.add(String(repo.name));
  const path = remotePath(repo.remote);
  if (path) denied.add(path);
}

const db = new Database(targetDb);
for (const table of ["runs", "agent_prs"]) {
  for (const row of db
    .query<{ repo: string }, []>(`SELECT DISTINCT repo FROM ${table} WHERE repo IS NOT NULL`)
    .all()) {
    denied.add(row.repo);
  }
}
for (const name of keptNames) if (name) denied.delete(name);
writeFileSync(join(to, "demo-deny.txt"), `${[...denied].sort().join("\n")}\n`);

const placeholders = (values: readonly string[]) => values.map(() => "?").join(", ");
const excluded = flags["exclude-origin"];
db.run(
  `DELETE FROM runs WHERE repo IS NULL OR repo NOT IN (${placeholders(repos)})` +
    (excluded.length > 0 ? ` OR origin IN (${placeholders(excluded)})` : ""),
  [...repos, ...excluded],
);
const excludedAutomations = flags["exclude-automation"];
if (excludedAutomations.length > 0) {
  db.run(
    `DELETE FROM runs WHERE automation_id IN (${placeholders(excludedAutomations)})`,
    excludedAutomations,
  );
}
db.run("DELETE FROM run_stages WHERE run_id NOT IN (SELECT id FROM runs)");
db.run("DELETE FROM run_artifacts WHERE run_id IS NULL OR run_id NOT IN (SELECT id FROM runs)");
db.run("DELETE FROM run_artifact_uploads WHERE artifact_id NOT IN (SELECT id FROM run_artifacts)");
db.run(`DELETE FROM agent_prs WHERE repo IS NULL OR repo NOT IN (${placeholders(repos)})`, repos);
const automationIds = keptAutomations.map((automation) => String(automation.id));
db.run(
  `DELETE FROM automation_schedules WHERE automation_id NOT IN (${placeholders(automationIds)})`,
  automationIds,
);
const tables = db
  .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all()
  .map((row) => row.name);
for (const table of tables) {
  if (!KEPT_TABLES.has(table)) db.run(`DELETE FROM "${table.replace(/"/g, '""')}"`);
}
db.run("VACUUM"); // drop the deleted rows' pages too
const runIds = new Set(
  db
    .query<{ id: number }, []>("SELECT id FROM runs")
    .all()
    .map((row) => row.id),
);
const artifactIds = db
  .query<{ id: string }, []>("SELECT id FROM run_artifacts")
  .all()
  .map((row) => row.id);
db.close();

// ---------------------------------------------------------------------------
// Transcripts and artifacts of kept runs only
// ---------------------------------------------------------------------------

// Strictly by run id: a transcript matched only by task key could belong to
// another repository's task with the same key.
const logsFrom = join(from, "logs", "harness");
const logsTo = join(to, "logs", "harness");
mkdirSync(logsTo, { recursive: true });
let logs = 0;
for (const name of existsSync(logsFrom) ? readdirSync(logsFrom) : []) {
  const runId = /__run(\d+)__/.exec(name)?.[1];
  if (runId && runIds.has(Number(runId))) {
    copyFileSync(join(logsFrom, name), join(logsTo, name));
    logs += 1;
  }
}

const storeDir = (dbPath: string) =>
  createHash("sha256").update(resolve(dbPath)).digest("hex").slice(0, 16);
const artifactsFrom = join(from, "artifacts", storeDir(sourceDb));
const artifactsTo = join(to, "artifacts", storeDir(flags["db-path-as"] ?? targetDb));
mkdirSync(artifactsTo, { recursive: true });
let artifacts = 0;
for (const id of artifactIds) {
  if (existsSync(join(artifactsFrom, id))) {
    copyFileSync(join(artifactsFrom, id), join(artifactsTo, id));
    artifacts += 1;
  }
}

console.log(
  `Copied ${runIds.size} runs, ${logs} transcripts, ${artifacts} artifact files, ` +
    `${keptAutomations.length} automations for ${[...repoNames].join(", ")} into ${to}`,
);
