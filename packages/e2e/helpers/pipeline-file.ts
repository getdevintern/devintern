/**
 * Workspace `pipeline_file` fixtures for worker e2e coverage.
 *
 * Writes pipeline JSON definitions and small, dependency-free TypeScript
 * plugin step modules into a temporary workspace. The built CLI loads those
 * modules at run time through Bun's module loader, exactly as it loads a
 * user's plugins from `~/.devintern/pipelines/`.
 *
 * Every generated plugin records one JSON marker per run so a test can prove
 * which steps ran, for which repository, with which `create(config)` options.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One marker written by a generated plugin step when it runs. */
export interface PipelineStepMarker {
  /** The plugin's step name. */
  step: string;
  /** `DEVINTERN_WORKSPACE_REPO` pinned by the worker for the task process. */
  repo: string | null;
  /** Task key from the pipeline context. */
  taskKey: string | null;
  /** Options `create(config)` received (the step entry without `use`). */
  config: Record<string, unknown>;
  /** Whether `commit` had already run when the step ran. */
  committed: boolean;
  /** Result kind the step returned. */
  result: "continue" | "warn" | "halt";
  /** Epoch ms when the step ran. */
  at: number;
}

/** One entry of a pipeline definition's `steps` array. */
export type PipelineStepEntry = { use: string } & Record<string, unknown>;

/** A workspace pipeline definition (`plugins` and `steps`). */
export interface PipelineDefinition {
  plugins?: string[];
  steps: PipelineStepEntry[];
}

/**
 * Source of a marker plugin named `name`.
 *
 * Step options it reads:
 * - `markerDir` (required): directory to write `<step>--<repo>--<n>.json` into.
 * - `haltMarker` / `warnMarker`: when the task prompt contains the marker the
 *   step returns `halt` / `warn` with `reason`; otherwise it continues.
 * - `reason`: the halt or warn reason.
 *
 * Types are inline so the temp workspace needs no package install.
 */
export function markerPluginSource(name: string): string {
  return `import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Context {
  taskKey?: string;
  taskContent?: string;
  committed?: boolean;
}
type Result =
  | { kind: "continue" }
  | { kind: "warn"; reason: string }
  | { kind: "halt"; reason: string };

const definition = {
  name: ${JSON.stringify(name)},
  create(config: Record<string, unknown>) {
    const markerDir = config.markerDir;
    if (typeof markerDir !== "string") throw new Error("markerDir option is required");
    return {
      name: ${JSON.stringify(name)},
      async run(context: Context): Promise<Result> {
        const content = context.taskContent ?? "";
        const reason = typeof config.reason === "string" ? config.reason : ${JSON.stringify(name)};
        let result: Result = { kind: "continue" };
        if (typeof config.haltMarker === "string" && content.includes(config.haltMarker)) {
          result = { kind: "halt", reason };
        } else if (typeof config.warnMarker === "string" && content.includes(config.warnMarker)) {
          result = { kind: "warn", reason };
        }
        const repo = process.env.DEVINTERN_WORKSPACE_REPO ?? null;
        mkdirSync(markerDir, { recursive: true });
        const prefix = \`\${${JSON.stringify(name)}}--\${repo ?? "unknown"}--\`;
        const index = readdirSync(markerDir).filter((entry) => entry.startsWith(prefix)).length;
        writeFileSync(
          join(markerDir, \`\${prefix}\${index}.json\`),
          JSON.stringify({
            step: ${JSON.stringify(name)},
            repo,
            taskKey: context.taskKey ?? null,
            config,
            committed: context.committed === true,
            result: result.kind,
            at: Date.now(),
          }),
        );
        return result;
      },
    };
  },
};

export default definition;
`;
}

/** Write a file, creating parent directories, and return its path. */
function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Write `<pipelinesDir>/steps/<name>.ts` with {@link markerPluginSource}. */
export function writeMarkerPlugin(pipelinesDir: string, name: string): string {
  return writeFile(join(pipelinesDir, "steps", `${name}.ts`), markerPluginSource(name));
}

/** Write a pipeline definition as `<pipelinesDir>/<fileName>`. */
export function writePipelineFile(
  pipelinesDir: string,
  fileName: string,
  definition: PipelineDefinition,
): string {
  return writeFile(join(pipelinesDir, fileName), `${JSON.stringify(definition, null, 2)}\n`);
}

/** Every marker in `markerDir`, ordered by the time its step ran. */
export function readStepMarkers(markerDir: string): PipelineStepMarker[] {
  if (!existsSync(markerDir)) return [];
  return readdirSync(markerDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(join(markerDir, entry), "utf8")) as PipelineStepMarker)
    .sort((a, b) => a.at - b.at);
}
