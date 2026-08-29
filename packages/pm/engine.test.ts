import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModuleDir } from "./lib/runtime/path.js";
import { createEngine, DEFAULT_ISSUE_TYPES, EngineError, extractJsonPayload } from "./lib/engine";
import { STRUCTURED_OUTPUT_ENV_VAR } from "./lib/engine/structured.js";
import type { StoryDraft } from "./lib/engine";
import type { Config } from "./lib/config";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./lib/backends";
import type { AgentHarness, AgentRunOptions, AgentRunResult } from "@devintern/agent-harness";

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

  test("repairs raw newlines inside JSON string values", () => {
    const raw = [
      "```json",
      "{",
      '  "summary": "Support GitLab",',
      '  "description": "## User Story',
      "",
      "As a developer using `gitlab.com`, I want support.",
      "",
      "## Acceptance",
      "",
      "- [ ] Works",
      '"',
      "}",
      "```",
    ].join("\n");
    expect(extractJsonPayload(raw, isStory, "missing fields")).toEqual({
      summary: "Support GitLab",
      description:
        "## User Story\n\nAs a developer using `gitlab.com`, I want support.\n\n## Acceptance\n\n- [ ] Works\n",
    });
  });

  test("ignores a stray extra closing brace after the object (grok)", () => {
    const raw = 'Narration.{"summary": "S", "description": "D.\\n"}\n}';
    expect(extractJsonPayload(raw, isStory, "missing fields")).toEqual({
      summary: "S",
      description: "D.\n",
    });
  });

  test("tolerates literal \\n junk between the final value and the closing brace (grok)", () => {
    const raw = 'Narration.{"summary": "S", "description": "D."\\n}';
    expect(extractJsonPayload(raw, isStory, "missing fields")).toEqual({
      summary: "S",
      description: "D.",
    });
  });

  test("escapes unescaped double quotes inside string values (opencode)", () => {
    const raw = [
      "```json",
      "{",
      '  "summary": "S",',
      '  "description": "A legacy "cwd" mode mutates the repo.',
      "",
      "Second paragraph with an inner ``` fence.",
      "```",
      '"auto-detect is fragile"',
      "```",
      "",
      "- [ ] Done",
      '"',
      "}",
      "```",
    ].join("\n");
    expect(extractJsonPayload(raw, isStory, "missing fields")).toEqual({
      summary: "S",
      description:
        'A legacy "cwd" mode mutates the repo.\n\nSecond paragraph with an inner ``` fence.\n```\n"auto-detect is fragile"\n```\n\n- [ ] Done\n',
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
    // Friendly, actionable headline — the low-level parser message stays out.
    expect((caught as EngineError).message).toContain("malformed output");
    expect((caught as EngineError).message).toContain("Retry");
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
function stubConfig(harnessOverrides: Partial<AgentHarness> = {}): Config {
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
        ...harnessOverrides,
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
    supportsLabels: true,
    supportsFreeformLabels: false,
    supportsAttachments: false,
    createTask: async (): Promise<CreatedTask> => ({ key: "PROJ-1", url: "http://t/PROJ-1" }),
    createSubtask: async (_parent: string, summary: string): Promise<CreatedTask> => ({
      key: `SUB-${summary}`,
      url: `http://t/${summary}`,
    }),
    linkToEpic: async () => {},
    applyLabels: async () => {},
    getProjects: async (): Promise<ProjectInfo[]> => [{ key: "PROJ", name: "Project" }],
    getIssueTypes: async () => ["Story", "Bug"],
    getLabels: async () => ({
      labels: [
        { id: "bug", name: "bug" },
        { id: "backend", name: "backend" },
      ],
      truncated: false,
    }),
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
    expect(engine.supportsAttachments).toBe(false);
    expect(engine.supportsLabels).toBe(true);
    expect(engine.supportsFreeformLabels).toBe(false);
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

  test("generateStory retries once with a corrective reminder after malformed output", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async (_harness, _path, prompt) => {
          prompts.push(prompt);
          calls += 1;
          return {
            stdout:
              calls === 1
                ? "Utter word salad, no object here."
                : '{"summary": "S", "description": "D"}',
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
          };
        },
      },
    );

    const draft = await engine.generateStory({
      source: { type: "prompt", content: "x" },
      promptStyle: "pm",
    });
    expect(draft).toEqual({ summary: "S", description: "D" });
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("could not be parsed as JSON");
    expect(prompts[1]).toContain(prompts[0] ?? "");
  });

  test("generateStory reports malformed output with a dump after exhausting the retry", async () => {
    let calls = 0;
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async () => {
          calls += 1;
          return {
            stdout: `Still unparsable attempt ${calls}.`,
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
          };
        },
      },
    );

    let caught: unknown;
    try {
      await engine.generateStory({
        source: { type: "prompt", content: "x" },
        promptStyle: "pm",
      });
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(2);
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("parse-failed");
    expect((caught as EngineError).message).toContain("malformed output");
    expect((caught as EngineError).dumpFile).toContain("devpm-story-generation-parse-");
    expect((caught as EngineError).detail).toContain("Still unparsable attempt 2.");
  });

  test("generateStory does not retry when the agent itself fails", async () => {
    let calls = 0;
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async () => {
          calls += 1;
          return { stdout: "", stderr: "boom\n", exitCode: 1, maxTurnsReached: false };
        },
      },
    );

    let caught: unknown;
    try {
      await engine.generateStory({
        source: { type: "prompt", content: "x" },
        promptStyle: "pm",
      });
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(1);
    expect((caught as EngineError).code).toBe("agent-failed");
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

  test("createTask uploads attachments when supported", async () => {
    const uploaded: string[] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          supportsAttachments: true,
          uploadAttachment: async (_key, filePath) => {
            uploaded.push(filePath);
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      {
        issueType: "Task",
        attachments: [
          { path: "/tmp/a.md", name: "a.md" },
          { path: "/tmp/b.png", name: "b.png" },
        ],
      },
    );
    expect(result.attachmentsUploaded).toBe(2);
    expect(result.attachmentErrors).toBeUndefined();
    expect(uploaded).toEqual(["/tmp/a.md", "/tmp/b.png"]);
  });

  test("createTask reports attachment upload failure without throwing", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          supportsAttachments: true,
          uploadAttachment: async () => {
            throw new Error("quota");
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", attachments: [{ path: "/tmp/a.md", name: "a.md" }] },
    );
    expect(result.task.key).toBe("PROJ-1");
    expect(result.attachmentsUploaded).toBe(0);
    expect(result.attachmentErrors).toEqual(["a.md: quota"]);
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

  test("createTask applies labels and reports success", async () => {
    const applied: string[][] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          applyLabels: async (_key, labels) => {
            applied.push(labels);
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", labels: ["bug", "backend"] },
    );
    expect(result.labelsApplied).toBe(true);
    expect(result.labelsApplyError).toBeUndefined();
    expect(applied).toEqual([["bug", "backend"]]);
  });

  test("createTask reports label apply failure without throwing", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          applyLabels: async () => {
            throw new Error("labels locked");
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", labels: ["bug"] },
    );
    expect(result.task.key).toBe("PROJ-1");
    expect(result.labelsApplied).toBe(false);
    expect(result.labelsApplyError).toBe("labels locked");
  });

  test("createTask rejects unknown labels before apply", async () => {
    const applied: string[][] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          applyLabels: async (_key, labels) => {
            applied.push(labels);
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", labels: ["bug", "invented"] },
    );
    expect(result.task.key).toBe("PROJ-1");
    expect(result.labelsApplied).toBe(false);
    expect(result.labelsApplyError).toBe("Unknown label(s): invented");
    expect(applied).toEqual([]);
  });

  test("createTask allows unknown labels when supportsFreeformLabels", async () => {
    const applied: string[][] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          supportsFreeformLabels: true,
          getLabels: async () => ({ labels: [], truncated: false }),
          applyLabels: async (_key, labels) => {
            applied.push(labels);
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", labels: ["brand-new", "also-new"] },
    );
    expect(result.labelsApplied).toBe(true);
    expect(result.labelsApplyError).toBeUndefined();
    expect(applied).toEqual([["brand-new", "also-new"]]);
  });

  test("createTask reuses listLabels cache instead of refetching", async () => {
    let getLabelsCalls = 0;
    const applied: string[][] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          getLabels: async () => {
            getLabelsCalls += 1;
            return {
              labels: [
                { id: "bug", name: "bug" },
                { id: "backend", name: "backend" },
              ],
              truncated: false,
            };
          },
          applyLabels: async (_key, labels) => {
            applied.push(labels);
          },
        }),
      },
    );

    await engine.listLabels();
    expect(getLabelsCalls).toBe(1);

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", labels: ["bug"] },
    );
    expect(result.labelsApplied).toBe(true);
    expect(getLabelsCalls).toBe(1);
    expect(applied).toEqual([["bug"]]);
  });

  test("createTask skips allowlist fetch when labelsPrevalidated", async () => {
    let getLabelsCalls = 0;
    const applied: string[][] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          getLabels: async () => {
            getLabelsCalls += 1;
            return { labels: [], truncated: false };
          },
          applyLabels: async (_key, labels) => {
            applied.push(labels);
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      // TrustedCreateTaskOptions is unexported — assert for in-process tests only.
      { issueType: "Task", labels: ["from-picker"], labelsPrevalidated: true } as {
        issueType: string;
        labels: string[];
        labelsPrevalidated: boolean;
      },
    );
    expect(result.labelsApplied).toBe(true);
    expect(getLabelsCalls).toBe(0);
    expect(applied).toEqual([["from-picker"]]);
  });

  test("createTask exhausts truncated catalogs before rejecting unknowns", async () => {
    let getLabelsCalls = 0;
    const applied: string[][] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          getLabels: async (_projectKey, options) => {
            getLabelsCalls += 1;
            if (options?.maxLabels === Number.POSITIVE_INFINITY) {
              return {
                labels: [
                  { id: "bug", name: "bug" },
                  { id: "deep", name: "deep" },
                ],
                truncated: false,
              };
            }
            return {
              labels: [{ id: "bug", name: "bug" }],
              truncated: true,
            };
          },
          applyLabels: async (_key, labels) => {
            applied.push(labels);
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", labels: ["deep"] },
    );
    expect(result.labelsApplied).toBe(true);
    expect(getLabelsCalls).toBe(2);
    expect(applied).toEqual([["deep"]]);
  });

  test("createTask skips labels when backend does not support them", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend({ supportsLabels: false, applyLabels: undefined }) },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", labels: ["bug"] },
    );
    expect(result.labelsApplied).toBe(false);
    expect(result.labelsApplyError).toBeUndefined();
  });

  test("createTask refuses labels when catalog API is missing", async () => {
    const applied: string[][] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          getLabels: undefined,
          applyLabels: async (_key, labels) => {
            applied.push(labels);
          },
        }),
      },
    );

    const result = await engine.createTask(
      { summary: "S", description: "D" },
      { issueType: "Task", labels: ["bug"] },
    );
    expect(result.task.key).toBe("PROJ-1");
    expect(result.labelsApplied).toBe(false);
    expect(result.labelsApplyError).toContain("does not expose a label catalog");
    expect(applied).toEqual([]);
  });

  test("listLabels returns empty catalog when unsupported", async () => {
    const unsupported = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend({ supportsLabels: false, getLabels: undefined }) },
    );
    expect(await unsupported.listLabels()).toEqual({ labels: [], truncated: false });

    const supported = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend() },
    );
    expect(await supported.listLabels()).toEqual({
      labels: [
        { id: "bug", name: "bug" },
        { id: "backend", name: "backend" },
      ],
      truncated: false,
    });
  });

  test("listLabels propagates truncated from the backend catalog", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend({
          getLabels: async () => ({
            labels: [{ id: "bug", name: "bug" }],
            truncated: true,
          }),
        }),
      },
    );
    expect(await engine.listLabels()).toEqual({
      labels: [{ id: "bug", name: "bug" }],
      truncated: true,
    });
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

describe("engine structured output (JSON mode)", () => {
  const STORY = { summary: "S", description: "D" };

  function generateInput() {
    return { source: { type: "prompt" as const, content: "x" }, promptStyle: "pm" as const };
  }

  test("requests structured output and reads the payload from result.structured", async () => {
    const seenOptions: AgentRunOptions[] = [];
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async (_harness, _path, _prompt, options) => {
          seenOptions.push(options);
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
            structured: { ok: true, value: STORY },
          };
        },
      },
    );

    const draft = await engine.generateStory(generateInput());
    expect(draft).toEqual(STORY);
    expect(seenOptions[0]?.structuredOutput).toBe(true);
  });

  test("unwraps a Claude Code result envelope before validating", async () => {
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: agentReturning({
          stdout:
            '{"type":"result","is_error":false,"result":"{\\"summary\\": \\"S\\", \\"description\\": \\"D\\"}"}',
          structured: {
            ok: true,
            value: {
              type: "result",
              subtype: "success",
              is_error: false,
              result: '{"summary": "S", "description": "D"}',
            },
          },
        }),
      },
    );

    const draft = await engine.generateStory(generateInput());
    expect(draft).toEqual(STORY);
  });

  test("unwraps the last assistant message from an NDJSON event stream", async () => {
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: agentReturning({
          stdout:
            '{"type":"thread.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"payload"}}\n{"type":"turn.completed"}',
          structured: {
            ok: true,
            value: [
              { type: "thread.started", thread_id: "t1" },
              {
                type: "item.completed",
                item: { type: "agent_message", text: '{"summary": "S", "description": "D"}' },
              },
              { type: "turn.completed", usage: {} },
            ],
          },
        }),
      },
    );

    const draft = await engine.generateStory(generateInput());
    expect(draft).toEqual(STORY);
  });

  test("unwraps decomposition payloads from a buffered message array", async () => {
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: agentReturning({
          stdout: "",
          structured: {
            ok: true,
            value: [
              { type: "system", content: "session context" },
              {
                role: "assistant",
                content: '{"subtasks": [{"summary": "A"}, {"summary": "B", "description": "b"}]}',
              },
            ],
          },
        }),
      },
    );

    const subtasks = await engine.decomposeStory({
      story: STORY,
      sourceType: "prompt",
      promptStyle: "pm",
    });
    expect(subtasks).toEqual([{ summary: "A" }, { summary: "B", description: "b" }]);
  });

  test("repairs narration-prefixed JSON inside the envelope reply text", async () => {
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: agentReturning({
          stdout: '{"type":"result","result":"narration + payload"}',
          structured: {
            ok: true,
            value: {
              type: "result",
              result:
                'I\'ll write the story now.\n```json\n{"summary": "S", "description": "D"}\n```',
            },
          },
        }),
      },
    );

    const draft = await engine.generateStory(generateInput());
    expect(draft).toEqual(STORY);
  });

  test("falls back to raw stdout repair when structured parsing fails", async () => {
    let calls = 0;
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async () => {
          calls += 1;
          return {
            stdout: '```json\n{"summary": "S", "description": "D"}\n```',
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
            structured: { ok: false, error: "no JSON found in agent stdout" },
          };
        },
      },
    );

    const draft = await engine.generateStory(generateInput());
    expect(draft).toEqual(STORY);
    expect(calls).toBe(1);
  });

  test("falls back to raw stdout when the structured payload does not validate", async () => {
    let calls = 0;
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async () => {
          calls += 1;
          return {
            stdout: '{"summary": "S", "description": "D"}',
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
            structured: { ok: true, value: { summary: "only" } },
          };
        },
      },
    );

    const draft = await engine.generateStory(generateInput());
    expect(draft).toEqual(STORY);
    expect(calls).toBe(1);
  });

  test("keeps the corrective re-run when structured parsing fails repeatedly", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async (_harness, _path, prompt) => {
          prompts.push(prompt);
          calls += 1;
          return {
            stdout: `garbage attempt ${calls}`,
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
            structured: { ok: false, error: "no JSON found in agent stdout" },
          };
        },
      },
    );

    let caught: unknown;
    try {
      await engine.generateStory(generateInput());
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("could not be parsed as JSON");
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("parse-failed");
    expect((caught as EngineError).dumpFile).toContain("devpm-story-generation-parse-");
  });

  test("does not request structured output from a harness without the capability", async () => {
    const seenOptions: AgentRunOptions[] = [];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async (_harness, _path, _prompt, options) => {
          seenOptions.push(options);
          return {
            stdout: '{"summary": "S", "description": "D"}',
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
          };
        },
      },
    );

    const draft = await engine.generateStory(generateInput());
    expect(draft).toEqual(STORY);
    expect(seenOptions[0]?.structuredOutput).toBe(false);
  });

  test("honors the structuredOutput opt-out option", async () => {
    const seenOptions: AgentRunOptions[] = [];
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR, structuredOutput: false },
      {
        backend: stubBackend(),
        runAgent: async (_harness, _path, _prompt, options) => {
          seenOptions.push(options);
          return {
            stdout: '{"summary": "S", "description": "D"}',
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
          };
        },
      },
    );

    const draft = await engine.generateStory(generateInput());
    expect(draft).toEqual(STORY);
    expect(seenOptions[0]?.structuredOutput).toBe(false);
  });

  test("honors the AGENT_STRUCTURED_OUTPUT opt-out env var", async () => {
    const previous = process.env[STRUCTURED_OUTPUT_ENV_VAR];
    process.env[STRUCTURED_OUTPUT_ENV_VAR] = "0";
    try {
      const seenOptions: AgentRunOptions[] = [];
      const engine = await createEngine(
        stubConfig({ supportsStructuredOutput: true }),
        { promptsDir: PROMPTS_DIR },
        {
          backend: stubBackend(),
          runAgent: async (_harness, _path, _prompt, options) => {
            seenOptions.push(options);
            return {
              stdout: '{"summary": "S", "description": "D"}',
              stderr: "",
              exitCode: 0,
              maxTurnsReached: false,
            };
          },
        },
      );

      const draft = await engine.generateStory(generateInput());
      expect(draft).toEqual(STORY);
      expect(seenOptions[0]?.structuredOutput).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env[STRUCTURED_OUTPUT_ENV_VAR];
      } else {
        process.env[STRUCTURED_OUTPUT_ENV_VAR] = previous;
      }
    }
  });
});

describe("readable stdout tap (structured streaming)", () => {
  function generateInput() {
    return { source: { type: "prompt" as const, content: "x" }, promptStyle: "pm" as const };
  }

  function engineEmittingStdout(emit: (onStdout: (chunk: string) => void) => void) {
    return createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async (_harness, _path, _prompt, options) => {
          emit(options.onStdout ?? (() => {}));
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            maxTurnsReached: false,
            structured: { ok: true, value: { summary: "S", description: "D" } },
          };
        },
      },
    );
  }

  test("streams readable assistant text instead of raw JSON events", async () => {
    const chunks: Array<[string, string]> = [];
    const engine = await engineEmittingStdout((onStdout) => {
      onStdout("boot log\n");
      onStdout(
        '{"type":"item.completed","item":{"type":"agent_message","text":"Working on it"}}\n',
      );
      // Envelope without a trailing newline: extracted on flush.
      onStdout('{"type":"result","result":"All done"}');
    });

    await engine.generateStory(generateInput(), {
      onAgentChunk: (chunk, stream) => chunks.push([stream, chunk]),
    });
    expect(chunks).toEqual([
      ["stdout", "boot log\n"],
      ["stdout", "Working on it\n"],
      ["stdout", "All done"],
    ]);
  });

  test("passes non-text JSON and non-JSON lines through unchanged", async () => {
    const chunks: Array<[string, string]> = [];
    const engine = await engineEmittingStdout((onStdout) => {
      onStdout('{"type":"turn.completed","usage":{"input_tokens":10}}\n');
      onStdout('  "summary": "partial",\n');
    });

    await engine.generateStory(generateInput(), {
      onAgentChunk: (chunk, stream) => chunks.push([stream, chunk]),
    });
    expect(chunks).toEqual([
      ["stdout", '{"type":"turn.completed","usage":{"input_tokens":10}}\n'],
      ["stdout", '  "summary": "partial",\n'],
    ]);
  });

  test("stderr chunks pass through untouched in structured mode", async () => {
    const chunks: Array<[string, string]> = [];
    const engine = await createEngine(
      stubConfig({ supportsStructuredOutput: true }),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async (_harness, _path, _prompt, options) => {
          options.onStderr?.("raw stderr");
          return {
            stdout: "",
            stderr: "raw stderr",
            exitCode: 0,
            maxTurnsReached: false,
            structured: { ok: true, value: { summary: "S", description: "D" } },
          };
        },
      },
    );

    await engine.generateStory(generateInput(), {
      onAgentChunk: (chunk, stream) => chunks.push([stream, chunk]),
    });
    expect(chunks).toEqual([["stderr", "raw stderr"]]);
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
