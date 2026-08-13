import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getModuleDir } from "./lib/runtime/path.js";
import { createEngine } from "./lib/engine";
import type { Config } from "./lib/config";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./lib/backends";
import type { AgentRunResult } from "@devintern/agent-harness";
import { createChatBot } from "./lib/chat/bot.js";
import type { ChatBot } from "./lib/chat/bot.js";
import { createMemorySessionStore } from "./lib/chat/store.js";
import type { SessionStore } from "./lib/chat/store.js";
import type { BotThread, OutgoingMessage } from "./lib/chat/types.js";

const PROMPTS_DIR = join(getModuleDir(import.meta.url), "prompts");

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
    supabase: { url: "http://localhost", publishableKey: "k", sessionFilePath: "/tmp/none.json" },
  } as unknown as Config;
}

function stubBackend(overrides: Partial<TaskBackend> = {}): TaskBackend {
  const backend: TaskBackend = {
    name: "Stub",
    supportsIssueTypes: true,
    supportsEpicLinking: false,
    supportsLabels: false,
    supportsFreeformLabels: false,
    supportsAttachments: false,
    createTask: async (): Promise<CreatedTask> => ({ key: "PROJ-1", url: "http://t/PROJ-1" }),
    createSubtask: async (_parent: string, summary: string): Promise<CreatedTask> => ({
      key: `SUB-${summary}`,
      url: `http://t/${summary}`,
    }),
    getProjects: async (): Promise<ProjectInfo[]> => [{ key: "PROJ", name: "Project" }],
    getIssueTypes: async () => ["Story", "Bug"],
  };
  return Object.assign(backend, overrides);
}

interface PostedMessage {
  current: OutgoingMessage;
  edits: OutgoingMessage[];
}

class FakeThread implements BotThread {
  readonly key: string;
  readonly platform = "slack" as const;
  readonly posts: PostedMessage[] = [];
  subscribed = false;

  constructor(key = "slack:C1:100.1") {
    this.key = key;
  }

  async subscribe(): Promise<void> {
    this.subscribed = true;
  }

  async startTyping(): Promise<void> {}

  async post(msg: OutgoingMessage) {
    const posted: PostedMessage = { current: msg, edits: [] };
    this.posts.push(posted);
    return {
      edit: async (updated: OutgoingMessage) => {
        posted.current = updated;
        posted.edits.push(updated);
      },
    };
  }

  /** All texts currently visible in the thread, in post order. */
  texts(): string[] {
    return this.posts.map((p) => p.current.text);
  }
}

/** Agent stub whose next responses are dequeued per call. */
function scriptedAgent(responses: string[]): () => Promise<AgentRunResult> {
  return async () => ({
    stdout: responses.shift() ?? "",
    stderr: "",
    exitCode: 0,
    maxTurnsReached: false,
  });
}

const STORY_JSON = '```json\n{"summary": "Add dark mode", "description": "Dark mode body"}\n```';
const EDITED_JSON =
  '```json\n{"summary": "Add dark mode", "description": "Stricter acceptance criteria"}\n```';
const SUBTASKS_JSON = '```json\n{"subtasks": [{"summary": "Tokens"}, {"summary": "Toggle"}]}\n```';

async function makeBot(
  agentResponses: string[],
  backendOverrides: Partial<TaskBackend> = {},
): Promise<{ bot: ChatBot; store: SessionStore }> {
  const engine = await createEngine(
    stubConfig(),
    { promptsDir: PROMPTS_DIR },
    { backend: stubBackend(backendOverrides), runAgent: scriptedAgent(agentResponses) },
  );
  const store = createMemorySessionStore();
  const bot = createChatBot({ engine, store });
  return { bot, store };
}

describe("chat bot", () => {
  test("new mention generates a draft, subscribes, and shows it with buttons", async () => {
    const { bot, store } = await makeBot([STORY_JSON]);
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);

    expect(thread.subscribed).toBe(true);
    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]!.current.text).toContain("**Add dark mode**");
    expect(thread.posts[0]!.current.buttons?.[0]?.actionId).toBe("devpm-create");
    expect(store.get(thread.key)?.status).toBe("drafted");
  });

  test("plain reply without a session is ignored", async () => {
    const { bot } = await makeBot([]);
    const thread = new FakeThread();

    await bot.handleMessage(thread, "random channel chatter", false);

    expect(thread.posts).toHaveLength(0);
    expect(bot.hasSession(thread.key)).toBe(false);
  });

  test("in-thread reply edits the draft in place", async () => {
    const { bot, store } = await makeBot([STORY_JSON, EDITED_JSON]);
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);
    await bot.handleMessage(thread, "make the acceptance criteria stricter", false);

    expect(store.get(thread.key)?.draft?.description).toBe("Stricter acceptance criteria");
    // Progress message became the new draft; still two messages total.
    expect(thread.posts).toHaveLength(2);
    expect(thread.posts[1]!.current.text).toContain("Stricter acceptance criteria");
    expect(store.get(thread.key)?.history).toEqual(["make the acceptance criteria stricter"]);
  });

  test("'create' reply files the task and posts the link", async () => {
    const { bot, store } = await makeBot([STORY_JSON]);
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);
    await bot.handleMessage(thread, "create", false);

    const session = store.get(thread.key);
    expect(session?.status).toBe("done");
    expect(session?.createdTaskKey).toBe("PROJ-1");
    expect(thread.texts().some((t) => t.includes("[PROJ-1](http://t/PROJ-1)"))).toBe(true);
  });

  test("approve via reaction is idempotent", async () => {
    let creates = 0;
    const { bot } = await makeBot([STORY_JSON], {
      createTask: async () => {
        creates += 1;
        return { key: "PROJ-1", url: "http://t/PROJ-1" };
      },
    });
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);
    await bot.handleApprove(thread);
    await bot.handleApprove(thread);
    await bot.handleMessage(thread, "create", false);

    expect(creates).toBe(1);
  });

  test("decompose stores subtasks and creates them with the task", async () => {
    const created: string[] = [];
    const { bot, store } = await makeBot([STORY_JSON, SUBTASKS_JSON], {
      createSubtask: async (_parent, summary) => {
        created.push(summary);
        return { key: `SUB-${summary}`, url: `http://t/${summary}` };
      },
    });
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);
    await bot.handleMessage(thread, "split", false);
    expect(store.get(thread.key)?.subtasks).toHaveLength(2);

    await bot.handleAction(thread, "devpm-create");
    expect(created).toEqual(["Tokens", "Toggle"]);
    expect(thread.texts().some((t) => t.includes("SUB-Tokens"))).toBe(true);
  });

  test("type/project settings update the draft message", async () => {
    const { bot, store } = await makeBot([STORY_JSON]);
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);
    await bot.handleMessage(thread, "type Bug", false);
    await bot.handleMessage(thread, "project OTHER", false);

    const session = store.get(thread.key);
    expect(session?.issueType).toBe("Bug");
    expect(session?.projectKey).toBe("OTHER");
    expect(thread.posts[0]!.current.text).toContain("Type: Bug · Project: OTHER");
  });

  test("message while busy queues the latest text and applies it after", async () => {
    let releaseGenerate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const responses = [STORY_JSON, EDITED_JSON];
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async () => {
          const stdout = responses.shift() ?? "";
          if (responses.length === 1) await gate; // block only the first call
          return { stdout, stderr: "", exitCode: 0, maxTurnsReached: false };
        },
      },
    );
    const store = createMemorySessionStore();
    const bot = createChatBot({ engine, store });
    const thread = new FakeThread();

    const first = bot.handleMessage(thread, "we need dark mode", true);
    await new Promise((r) => setTimeout(r, 10));
    await bot.handleMessage(thread, "make it stricter", false);
    expect(thread.texts().some((t) => t.includes("Still working"))).toBe(true);

    releaseGenerate!();
    await first;
    await bot.drain();
    // Queued edit ran after the generate finished.
    await new Promise((r) => setTimeout(r, 10));
    await bot.drain();
    expect(store.get(thread.key)?.draft?.description).toBe("Stricter acceptance criteria");
  });

  test("agent failure posts a friendly error and the thread stays usable", async () => {
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      {
        backend: stubBackend(),
        runAgent: async () => ({
          stdout: "",
          stderr: "kaboom",
          exitCode: 1,
          maxTurnsReached: false,
        }),
      },
    );
    const store = createMemorySessionStore();
    const bot = createChatBot({ engine, store });
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);

    expect(store.get(thread.key)?.status).toBe("failed");
    expect(thread.texts().some((t) => t.includes("devpm serve"))).toBe(true);
    expect(thread.texts().some((t) => t.includes("kaboom"))).toBe(false);
  });

  test("reply after done points at the created task; new mention starts fresh", async () => {
    const { bot, store } = await makeBot([STORY_JSON, STORY_JSON]);
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);
    await bot.handleMessage(thread, "create", false);
    await bot.handleMessage(thread, "one more thing", false);
    expect(thread.texts().some((t) => t.includes("already produced"))).toBe(true);

    await bot.handleMessage(thread, "now light mode", true);
    expect(store.get(thread.key)?.status).toBe("drafted");
    expect(store.get(thread.key)?.source.content).toBe("now light mode");
  });

  test("sweepExpiredSessions drops idle sessions", async () => {
    let clock = 1000;
    const engine = await createEngine(
      stubConfig(),
      { promptsDir: PROMPTS_DIR },
      { backend: stubBackend(), runAgent: scriptedAgent([STORY_JSON]) },
    );
    const store = createMemorySessionStore();
    const bot = createChatBot({ engine, store, sessionTtlMs: 100, now: () => clock });
    const thread = new FakeThread();

    await bot.handleMessage(thread, "we need dark mode", true);
    clock += 1000;
    await bot.sweepExpiredSessions();
    expect(bot.hasSession(thread.key)).toBe(false);
  });
});
