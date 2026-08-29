import { describe, expect, test, afterEach } from "bun:test";
import { join } from "node:path";
import { EngineError } from "./lib/engine/index.js";
import { classifyReply, createSession, isExpired, APPROVE_EMOJI } from "./lib/chat/session.js";
import type { DraftSession } from "./lib/chat/session.js";
import { createFileSessionStore, createMemorySessionStore } from "./lib/chat/store.js";
import {
  renderAlreadyCreated,
  renderCreated,
  renderDraft,
  renderError,
  renderHelp,
} from "./lib/chat/messages.js";
import { getModuleDir } from "./lib/runtime/path.js";
import { readFile, rm } from "./lib/runtime/fs.js";

const KEY = "slack:C123:1000.1";

const TEST_DIR = join(getModuleDir(import.meta.url), "tmp-chat-store");

afterEach(async () => {
  await rm(TEST_DIR);
});

describe("createSession", () => {
  test("creates a generating session with prompt source", () => {
    const session = createSession(KEY, "slack", "add dark mode", 42);
    expect(session.status).toBe("generating");
    expect(session.source).toEqual({ type: "prompt", content: "add dark mode" });
    expect(session.issueType).toBe("Task");
    expect(session.updatedAt).toBe(42);
    expect(session.key).toBe(KEY);
    expect(session.platform).toBe("slack");
  });
});

describe("classifyReply", () => {
  test.each(["create", "Approve", "ship it", "LGTM", "yes", "ok!", "✅"])(
    "approves on %p",
    (text) => {
      expect(classifyReply(text)).toEqual({ kind: "approve" });
    },
  );

  test.each(["split", "decompose", "Split into subtasks", "break it down"])(
    "decomposes on %p",
    (text) => {
      expect(classifyReply(text)).toEqual({ kind: "decompose" });
    },
  );

  test("recognizes type changes", () => {
    expect(classifyReply("type Bug")).toEqual({ kind: "set-type", issueType: "Bug" });
    expect(classifyReply("type: User Story")).toEqual({
      kind: "set-type",
      issueType: "User Story",
    });
  });

  test("recognizes project changes", () => {
    expect(classifyReply("project PROJ")).toEqual({ kind: "set-project", projectKey: "PROJ" });
  });

  test("recognizes help", () => {
    expect(classifyReply("help")).toEqual({ kind: "help" });
    expect(classifyReply("?")).toEqual({ kind: "help" });
  });

  test("treats everything else as an edit request", () => {
    expect(classifyReply("make the acceptance criteria stricter")).toEqual({
      kind: "edit",
      prompt: "make the acceptance criteria stricter",
    });
    // Approval keywords inside longer sentences are edits, not approvals.
    expect(classifyReply("yes but add a rollout plan").kind).toBe("edit");
  });
});

describe("approve emoji", () => {
  test("covers Slack names and raw emoji", () => {
    expect(APPROVE_EMOJI.has("white_check_mark")).toBe(true);
    expect(APPROVE_EMOJI.has("+1")).toBe(true);
    expect(APPROVE_EMOJI.has("👍")).toBe(true);
    expect(APPROVE_EMOJI.has("eyes")).toBe(false);
  });
});

describe("isExpired", () => {
  test("expires only past the ttl", () => {
    const session = createSession(KEY, "slack", "idea", 1000);
    expect(isExpired(session, 1000 + 10, 100)).toBe(false);
    expect(isExpired(session, 1000 + 101, 100)).toBe(true);
  });
});

function draftedSession(overrides: Partial<DraftSession> = {}): DraftSession {
  return {
    ...createSession(KEY, "slack", "add dark mode", 1),
    status: "drafted",
    draft: { summary: "Add dark mode", description: "As a user I want dark mode." },
    ...overrides,
  };
}

describe("SessionStore (file)", () => {
  const storePath = join(TEST_DIR, "sessions.json");

  test("round-trips sessions across restarts", async () => {
    const store = await createFileSessionStore(storePath);
    await store.upsert(draftedSession());
    await store.close();

    const reopened = await createFileSessionStore(storePath);
    const loaded = reopened.get(KEY);
    expect(loaded?.draft?.summary).toBe("Add dark mode");
    expect(loaded?.status).toBe("drafted");
  });

  test("rewrites interrupted generating/creating sessions to failed on load", async () => {
    const store = await createFileSessionStore(storePath);
    await store.upsert(draftedSession({ status: "generating" }));
    await store.close();

    const reopened = await createFileSessionStore(storePath);
    expect(reopened.get(KEY)?.status).toBe("failed");
  });

  test("survives a corrupt store file", async () => {
    const store = await createFileSessionStore(storePath);
    await store.upsert(draftedSession());
    await store.close();
    const raw = await readFile(storePath);
    const { writeFile } = await import("./lib/runtime/fs.js");
    await writeFile(storePath, raw.slice(0, 20));

    const reopened = await createFileSessionStore(storePath);
    expect(reopened.all()).toEqual([]);
  });

  test("sweepExpired removes idle sessions and persists", async () => {
    const store = await createFileSessionStore(storePath);
    await store.upsert(draftedSession({ updatedAt: 0 }));
    const removed = await store.sweepExpired(1000, 100);
    expect(removed).toHaveLength(1);
    await store.close();

    const reopened = await createFileSessionStore(storePath);
    expect(reopened.all()).toEqual([]);
  });

  test("delete removes a session", async () => {
    const store = createMemorySessionStore();
    await store.upsert(draftedSession());
    await store.delete(KEY);
    expect(store.get(KEY)).toBeUndefined();
  });
});

describe("messages", () => {
  test("renderDraft shows title, description, settings, and buttons", () => {
    const msg = renderDraft(draftedSession({ projectKey: "PROJ" }));
    expect(msg.text).toContain("**Add dark mode**");
    expect(msg.text).toContain("As a user I want dark mode.");
    expect(msg.text).toContain("Type: Task · Project: PROJ");
    expect(msg.buttons?.map((b) => b.actionId)).toEqual(["devpm-create", "devpm-decompose"]);
  });

  test("renderDraft truncates very long descriptions", () => {
    const msg = renderDraft(
      draftedSession({ draft: { summary: "Big", description: "x".repeat(5000) } }),
    );
    expect(msg.text.length).toBeLessThan(4096);
    expect(msg.text).toContain("truncated for chat");
  });

  test("renderDraft lists subtasks when present", () => {
    const msg = renderDraft(
      draftedSession({ subtasks: [{ summary: "Design tokens" }, { summary: "Toggle UI" }] }),
    );
    expect(msg.text).toContain("- Design tokens");
    expect(msg.text).toContain("- Toggle UI");
  });

  test("renderCreated links the task and reports partial failures", () => {
    const msg = renderCreated(
      {
        task: { key: "PROJ-1", url: "https://tracker/PROJ-1" },
        epicLinked: false,
        epicLinkError: "epic not found",
        labelsApplied: false,
        attachmentsUploaded: 0,
      },
      ["PROJ-2"],
      ["Subtask 'X' failed: boom"],
    );
    expect(msg.text).toContain("[PROJ-1](https://tracker/PROJ-1)");
    expect(msg.text).toContain("PROJ-2");
    expect(msg.text).toContain("epic not found");
    expect(msg.text).toContain("boom");
  });

  test("renderError maps engine codes to friendly text without leaking detail", () => {
    const msg = renderError(new EngineError("parse-failed", "bad json", "RAW AGENT DUMP"));
    expect(msg.text).toContain("malformed output");
    expect(msg.text).toContain("switch harness/model");
    expect(msg.text).not.toContain("RAW AGENT DUMP");
    expect(
      renderError(
        new EngineError("parse-failed", "bad json", "d", "/tmp/devpm-story-generation-parse-1.log"),
      ).text,
    ).toContain("/tmp/devpm-story-generation-parse-1.log");
    expect(renderError(new EngineError("agent-failed", "x")).text).toContain("devpm serve");
    expect(renderError(new Error("plain")).text).toContain("plain");
  });

  test("renderAlreadyCreated links the created task", () => {
    const msg = renderAlreadyCreated(
      draftedSession({
        status: "done",
        createdTaskKey: "PROJ-9",
        createdTaskUrl: "https://tracker/PROJ-9",
      }),
    );
    expect(msg.text).toContain("[PROJ-9](https://tracker/PROJ-9)");
  });

  test("renderHelp mentions the bot name", () => {
    expect(renderHelp("devpm").text).toContain("@devpm");
  });
});
