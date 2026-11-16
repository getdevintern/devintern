import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UsageLimitError } from "@devintern/agent-harness";
import type {
  AgentHarness,
  AgentRunResult,
  HarnessChainEntry,
  AgentRunOptions,
} from "@devintern/agent-harness";
import { getModuleDir } from "./lib/runtime/path.js";
import { createEngine, EngineError } from "./lib/engine";
import type { Config } from "./lib/config";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./lib/backends";

const PROMPTS_DIR = join(getModuleDir(import.meta.url), "prompts");
const GOOD = '{"summary": "Title", "description": "Body"}';

function stubHarness(name: string): AgentHarness {
  return {
    name,
    displayName: `${name} agent`,
    defaultPath: name,
    buildArgs: () => [],
  } as unknown as AgentHarness;
}

function entry(name: string, path: string): HarnessChainEntry {
  return { name, harness: stubHarness(name), path, installed: true };
}

function stubConfig(fallbacks: HarnessChainEntry[] = []): Config {
  return {
    backend: { type: "markdown" },
    verbose: false,
    agent: { harness: stubHarness("a"), path: "/bin/a" },
    agentFallbacks: fallbacks,
  } as unknown as Config;
}

function stubBackend(): TaskBackend {
  return {
    name: "Stub",
    supportsIssueTypes: false,
    supportsEpicLinking: false,
    supportsLabels: false,
    supportsFreeformLabels: false,
    supportsAttachments: false,
    createTask: async (): Promise<CreatedTask> => ({ key: "P-1", url: "http://t/P-1" }),
    createSubtask: async (): Promise<CreatedTask> => ({ key: "S-1", url: "http://t/S-1" }),
    linkToEpic: async () => {},
    applyLabels: async () => {},
    getProjects: async (): Promise<ProjectInfo[]> => [],
    getIssueTypes: async () => [],
    getLabels: async () => ({ labels: [], truncated: false }),
  } as unknown as TaskBackend;
}

interface Call {
  harness: string;
  path: string;
  prompt: string;
  model?: string;
  effort?: string;
}

/**
 * Scripted runner: `behavior[harness]` returns stdout, a result override, or
 * throws a usage limit; every call is recorded.
 */
function scriptedRunner(
  behavior: Record<string, (callIndex: number) => Partial<AgentRunResult> | "limit">,
) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const runAgent = async (
    harness: AgentHarness,
    path: string,
    prompt: string,
    options: AgentRunOptions,
  ): Promise<AgentRunResult> => {
    calls.push({
      harness: harness.name,
      path,
      prompt,
      model: options.model,
      effort: options.effort,
    });
    const n = counts[harness.name] ?? 0;
    counts[harness.name] = n + 1;
    const outcome = behavior[harness.name]?.(n) ?? "limit";
    if (outcome === "limit") throw new UsageLimitError(`${harness.name}-reset`);
    return { stdout: "", stderr: "", exitCode: 0, maxTurnsReached: false, ...outcome };
  };
  return { calls, runAgent };
}

async function generate(config: Config, runAgent: ReturnType<typeof scriptedRunner>["runAgent"]) {
  const engine = await createEngine(
    config,
    { promptsDir: PROMPTS_DIR, model: "primary-model", effort: "high" },
    { backend: stubBackend(), runAgent },
  );
  return {
    engine,
    run: () =>
      engine.generateStory({ source: { type: "prompt", content: "x" }, promptStyle: "pm" }),
  };
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("engine harness failover on usage limits", () => {
  const originalError = console.error;
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    delete process.env.A_MODEL;
    delete process.env.B_MODEL;
    delete process.env.C_MODEL;
  });

  afterEach(() => {
    console.error = originalError;
    delete process.env.A_MODEL;
    delete process.env.B_MODEL;
    delete process.env.C_MODEL;
  });

  test("falls over to the next harness with its own path and no primary model", async () => {
    const { calls, runAgent } = scriptedRunner({ a: () => "limit", b: () => ({ stdout: GOOD }) });
    const { run } = await generate(stubConfig([entry("b", "/bin/b")]), runAgent);

    expect(await run()).toEqual({ summary: "Title", description: "Body" });
    expect(calls.map((c) => c.harness)).toEqual(["a", "b"]);
    expect(calls[0]).toMatchObject({ path: "/bin/a", model: "primary-model", effort: "high" });
    expect(calls[1]).toMatchObject({ path: "/bin/b", model: undefined, effort: undefined });
    expect(calls[1]?.prompt).toBe(calls[0]?.prompt);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('"a"');
    expect(stderr[0]).toContain("a-reset");
    expect(stderr[0]).toContain('"b"');
  });

  test("a fallback uses its own <HARNESS>_MODEL", async () => {
    process.env.B_MODEL = "b-model";
    const { calls, runAgent } = scriptedRunner({ a: () => "limit", b: () => ({ stdout: GOOD }) });
    const { run } = await generate(stubConfig([entry("b", "/bin/b")]), runAgent);

    await run();
    expect(calls[1]?.model).toBe("b-model");
  });

  test("a primary standing in for a dropped first entry gets fallback model/effort", async () => {
    process.env.A_MODEL = "a-own-model";
    const { calls, runAgent } = scriptedRunner({ a: () => ({ stdout: GOOD }) });
    const config = { ...stubConfig(), agentIsFallback: true } as Config;
    const { run } = await generate(config, runAgent);

    await run();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ harness: "a", model: "a-own-model", effort: undefined });
  });

  test("throws an EngineError listing every harness when all are limited", async () => {
    const { calls, runAgent } = scriptedRunner({});
    const { run } = await generate(
      stubConfig([entry("b", "/bin/b"), entry("c", "/bin/c")]),
      runAgent,
    );

    const error = await catchError(run());
    expect(error).toBeInstanceOf(EngineError);
    expect(error).not.toBeInstanceOf(UsageLimitError);
    expect((error as EngineError).code).toBe("agent-failed");
    const message = (error as EngineError).message;
    expect(message).toContain("All configured agent harnesses are usage-limited");
    for (const name of ['"a"', '"b"', '"c"']) expect(message).toContain(name);
    expect(calls.map((c) => c.harness)).toEqual(["a", "b", "c"]);
  });

  test("a single harness (or --harness) never tries another harness", async () => {
    const { calls, runAgent } = scriptedRunner({ b: () => ({ stdout: GOOD }) });
    const { run } = await generate(stubConfig([]), runAgent);

    const error = await catchError(run());
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).message).toContain('"a"');
    expect((error as EngineError).message).toContain("usage-limited");
    expect(calls.map((c) => c.harness)).toEqual(["a"]);
  });

  test("a config without agentFallbacks behaves as a single harness", async () => {
    const { calls, runAgent } = scriptedRunner({});
    const config = stubConfig();
    delete (config as { agentFallbacks?: unknown }).agentFallbacks;
    const { run } = await generate(config, runAgent);

    expect(await catchError(run())).toBeInstanceOf(EngineError);
    expect(calls).toHaveLength(1);
  });

  test("a non-zero exit that is not a usage limit does not fail over", async () => {
    const { calls, runAgent } = scriptedRunner({
      a: () => ({ exitCode: 1, stderr: "boom" }),
      b: () => ({ stdout: GOOD }),
    });
    const { run } = await generate(stubConfig([entry("b", "/bin/b")]), runAgent);

    const error = await catchError(run());
    expect((error as EngineError).detail).toBe("boom");
    expect(calls.map((c) => c.harness)).toEqual(["a"]);
    expect(stderr).toHaveLength(0);
  });

  test("the strict-JSON retry and later calls stay on the fallback", async () => {
    const { calls, runAgent } = scriptedRunner({
      a: () => "limit",
      b: (n) => (n === 0 ? { stdout: "not json" } : { stdout: GOOD }),
    });
    const { run } = await generate(stubConfig([entry("b", "/bin/b")]), runAgent);

    expect(await run()).toEqual({ summary: "Title", description: "Body" });
    expect(calls.map((c) => c.harness)).toEqual(["a", "b", "b"]);
    expect(calls[2]?.prompt).toContain("could not be parsed as JSON");

    await run();
    expect(calls.map((c) => c.harness)).toEqual(["a", "b", "b", "b"]);
  });

  test("a sticky fallback that becomes limited wraps back to the primary", async () => {
    const { calls, runAgent } = scriptedRunner({
      a: (n) => (n === 0 ? "limit" : { stdout: GOOD }),
      b: (n) => (n === 0 ? { stdout: GOOD } : "limit"),
    });
    const { run } = await generate(stubConfig([entry("b", "/bin/b")]), runAgent);

    await run();
    await run();
    expect(calls.map((c) => c.harness)).toEqual(["a", "b", "b", "a"]);
    expect(calls[3]).toMatchObject({ model: "primary-model", effort: "high" });
  });

  test("swapping config.agent resets failover to the new primary", async () => {
    const { calls, runAgent } = scriptedRunner({
      a: () => "limit",
      b: () => ({ stdout: GOOD }),
      c: () => ({ stdout: GOOD }),
    });
    const config = stubConfig([entry("b", "/bin/b")]);
    const { run } = await generate(config, runAgent);

    await run();
    config.agent = { harness: stubHarness("c"), path: "/bin/c" };
    config.agentFallbacks = [];
    await run();
    expect(calls.map((c) => c.harness)).toEqual(["a", "b", "c"]);
  });
});
