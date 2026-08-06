import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModuleDir } from "./lib/runtime/path.js";
import {
  createEngine,
  DEFAULT_ISSUE_TYPES,
  EngineError,
  extractJsonPayload,
  type StoryDraft,
} from "./lib/engine";
import type { Config } from "./lib/config";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./lib/backends";
import type { AgentRunResult } from "@devintern/agent-harness";

const PROMPTS_DIR = join(getModuleDir(import.meta.url), "prompts");

function isStory(value: unknown): value is StoryDraft {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.summary) && Boolean(record.description);
}

describe("extractJsonPayload", () => {
  test("parses JSON inside a fenced json block", () => {
    const raw = 'Some preamble\n```json\n{"summary": "S", "description": "D"}\n```\ntrailing';
    expect(extractJsonPayload(raw, isStory, "missing fields")).toEqual({
      summary: "S",
      description: "D",
    });
  });

  test("parses JSON inside an unlabeled fence", () => {
    const raw = '```\n{"summary": "S", "description": "D"}\n```';
    expect(extractJsonPayload(raw, isStory, "missing fields").summary).toBe("S");
  });

  test("parses bare JSON without fences", () => {
    const raw = '{"summary": "S", "description": "D"}';
    expect(extractJsonPayload(raw, isStory, "missing fields").description).toBe("D");
  });

  test("falls back to brace slice when the closing fence is missing", () => {
    const raw = '```json\n{"summary": "S", "description": "D"}';
    expect(extractJsonPayload(raw, isStory, "missing fields").summary).toBe("S");
  });

  test("falls back to brace slice when JSON strings contain nested code fences", () => {
    const payload = {
      summary: "S",
      description: "Use this:\n```bash\nnpm run export\n```\ndone",
    };
    const raw = "```json\n" + JSON.stringify(payload) + "\n```";
    expect(extractJsonPayload(raw, isStory, "missing fields")).toEqual(payload);
  });

  test("parses prose-prefixed bare JSON (agent narration before the object)", () => {
    const raw = 'I\'ll explore the codebase first.\n{"summary": "S", "description": "D"}\nDone.';
    expect(extractJsonPayload(raw, isStory, "missing fields")).toEqual({
      summary: "S",
      description: "D",
    });
  });

  test("throws parse-failed with raw output in detail for garbage", () => {
    let caught: unknown;
    try {
      extractJsonPayload("I could not produce JSON, sorry.", isStory, "missing fields");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("parse-failed");
    expect((caught as EngineError).detail).toContain("could not produce JSON");
  });

  test("throws parse-failed with invalidMessage when fields are missing", () => {
    let caught: unknown;
    try {
      extractJsonPayload('{"summary": "only summary"}', isStory, "missing fields");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).message).toBe("missing fields");
  });
});

/** Minimal config stub; engine only reads tracker default keys and agent config. */
function stubConfig(): Config {
  return {
    backend: { type: "markdown" },
    verbose: false,
    jira: {
      domain: "example.atlassian.net",
      email: "a@b.c",
      apiToken: "t",
      defaultProjectKey: "PROJ",
      verbose: false,
    },
    agent: {
      harness: {
        name: "stub",
        displayName: "Stub Agent",
        defaultPath: "stub",
        buildArgs: () => [],
      },
      path: "stub",
    },
  } as unknown as Config;
}

function stubBackend(overrides: Partial<TaskBackend> = {}): TaskBackend {
  return {
    name: "Stub",
    supportsIssueTypes: true,
    supportsEpicLinking: true,
    createTask: async (): Promise<CreatedTask> => ({ key: "PROJ-1", url: "http://t/PROJ-1" }),
    createSubtask: async (_parent: string, summary: string): Promise<CreatedTask> => ({
      key: `SUB-${summary}`,
      url: `http://t/${summary}`,
    }),
    linkToEpic: async () => {},
    getProjects: async (): Promise<ProjectInfo[]> => [{ key: "PROJ", name: "Project" }],
    getIssueTypes: async () => ["Story", "Bug"],
    ...overrides,
  };
}

function agentReturning(result: Partial<AgentRunResult>) {
  return async (): Promise<AgentRunResult> => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    maxTurnsReached: false,
    ...result,
  });
}

describe("createEngine", () => {
  test("exposes backend capabilities and default project key", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend() },
    );
    expect(engine.backendName).toBe("Stub");
    expect(engine.supportsIssueTypes).toBe(true);
    expect(engine.supportsEpicLinking).toBe(true);
    expect(engine.defaultProjectKey).toBe("PROJ");
  });

  test("generateStory returns parsed draft from agent output", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: agentReturning({
          stdout: '```json\n{"summary": "Title", "description": "Body"}\n```',
        }),
      },
    );

    const draft = await engine.generateStory({
      source: { type: "prompt", content: "Build a widget" },
      promptStyle: "pm",
    });
    expect(draft).toEqual({ summary: "Title", description: "Body" });
  });

  test("generateStory throws agent-failed with stderr detail on non-zero exit", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: agentReturning({ exitCode: 1, stderr: "boom\n" }),
      },
    );

    let caught: unknown;
    try {
      await engine.generateStory({
        source: { type: "prompt", content: "x" },
        promptStyle: "technical",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("agent-failed");
    expect((caught as EngineError).detail).toBe("boom");
  });

  test("generateStory streams agent chunks through events", async () => {
    const chunks: Array<[string, string]> = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async (_harness, _path, _prompt, options) => {
          options.onStdout?.("out-chunk");
          options.onStderr?.("err-chunk");
          return {
            stdout: '{"summary": "S", "description": "D"}',
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
          };
        },
      },
    );

    await engine.generateStory(
      { source: { type: "log", content: "trace" }, promptStyle: "pm" },
      { onAgentChunk: (chunk, stream) => chunks.push([stream, chunk]) },
    );
    expect(chunks).toEqual([
      ["stdout", "out-chunk"],
      ["stderr", "err-chunk"],
    ]);
  });

  test("editStory includes current draft and edit request in the prompt", async () => {
    let seenPrompt = "";
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async (_h, _p, prompt) => {
          seenPrompt = prompt;
          return {
            stdout: '{"summary": "S2", "description": "D2"}',
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
          };
        },
      },
    );

    const updated = await engine.editStory({
      current: { summary: "Old title", description: "Old body" },
      editPrompt: "make it shorter",
      issueType: "Story",
    });
    expect(updated.summary).toBe("S2");
    expect(seenPrompt).toContain("Old title");
    expect(seenPrompt).toContain("Old body");
    expect(seenPrompt).toContain("make it shorter");
    expect(seenPrompt).toContain("Revise this story");
    expect(seenPrompt).toContain("Current Description:");
  });

  test("decomposeStory returns subtasks array", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: agentReturning({
          stdout:
            '```json\n{"subtasks": [{"summary": "A"}, {"summary": "B", "description": "b"}]}\n```',
        }),
      },
    );

    const subtasks = await engine.decomposeStory({
      story: { summary: "S", description: "D" },
      sourceType: "prompt",
      promptStyle: "pm",
    });
    expect(subtasks).toHaveLength(2);
    expect(subtasks[1]).toEqual({ summary: "B", description: "b" });
  });

  test("createTask links epic and reports success", async () => {
    const linked: string[] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          linkToEpic: async (storyKey, epicKey) => {
            linked.push(`${storyKey}->${epicKey}`);
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", epicKey: "PROJ-100" },
    );
    expect(result.task.key).toBe("PROJ-1");
    expect(result.epicLinked).toBe(true);
    expect(result.epicLinkError).toBeUndefined();
    expect(linked).toEqual(["PROJ-1->PROJ-100"]);
  });

  test("createTask reports epic link failure without throwing", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          linkToEpic: async () => {
            throw new Error("no epic access");
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", epicKey: "PROJ-100" },
    );
    expect(result.epicLinked).toBe(false);
    expect(result.epicLinkError).toBe("no epic access");
  });

  test("createTask skips epic linking when backend does not support it", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend({ supportsEpicLinking: false, linkToEpic: undefined }) },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", epicKey: "PROJ-100" },
    );
    expect(result.epicLinked).toBe(false);
    expect(result.epicLinkError).toBeUndefined();
  });

  test("createSubtask falls back to summary when description is empty", async () => {
    const seen: Array<{ summary: string; description?: string }> = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          createSubtask: async (_parent, summary, description) => {
            seen.push({ summary, description });
            return { key: "SUB-1", url: "http://t/SUB-1" };
          },
        }),
      },
    );

    await engine.createSubtask("PROJ-1", { summary: "Only summary", description: "  " });
    expect(seen[0]).toEqual({ summary: "Only summary", description: "Only summary" });
  });

  test("listIssueTypes returns [] when unsupported and defaults without a fetcher", async () => {
    const noTypes = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend({ supportsIssueTypes: false }) },
    );
    expect(await noTypes.listIssueTypes()).toEqual([]);

    const noFetcher = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend({ getIssueTypes: undefined }) },
    );
    expect(await noFetcher.listIssueTypes()).toEqual(DEFAULT_ISSUE_TYPES);
  });

  test("listProjects returns undefined when backend has no project listing", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend({ getProjects: undefined }) },
    );
    expect(await engine.listProjects()).toBeUndefined();
  });
});

describe("engine module isolation", () => {
  test("lib/engine must not import from lib/components (keeps engine ink-free)", async () => {
    const engineDir = join(getModuleDir(import.meta.url), "lib", "engine");
    const entries = await readdir(engineDir);
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      const content = await readFile(join(engineDir, entry), "utf-8");
      expect(content).not.toMatch(/from\s+["'][^"']*components\//);
      expect(content).not.toMatch(/from\s+["']ink/);
      expect(content).not.toMatch(/from\s+["']react/);
    }
  });
});
