import { describe, expect, test } from "bun:test";
import {
  initialOutputState,
  isBusy,
  outputReducer,
  type OutputAction,
  type OutputState,
} from "./app-store.ts";

const draft = { summary: "Title", description: "Body" };
const error = { code: "agent-failed", message: "boom" };

function run(actions: OutputAction[], from: OutputState = initialOutputState): OutputState {
  return actions.reduce(outputReducer, from);
}

describe("outputReducer", () => {
  test("generate flow: idle → generating → preview", () => {
    let state = run([{ type: "generate-started", requestId: "r1" }]);
    expect(state.phase).toBe("generating");
    expect(isBusy(state.phase)).toBe(true);

    state = run([{ type: "generate-succeeded", draft }], state);
    expect(state.phase).toBe("preview");
    expect(state.draft).toEqual(draft);
    expect(state.activeRequestId).toBeNull();
  });

  test("generate-started resets stale output from a previous run", () => {
    const dirty = run([
      { type: "generate-started", requestId: "r1" },
      { type: "agent-chunk", requestId: "r1", chunk: "old log" },
      { type: "generate-succeeded", draft },
      { type: "create-started" },
      {
        type: "create-succeeded",
        created: {
          key: "T-1",
          url: "u",
          epicLinked: false,
          labelsApplied: false,
          attachmentsUploaded: 0,
        },
      },
    ]);
    const state = outputReducer(dirty, { type: "generate-started", requestId: "r2" });
    expect(state.agentLog).toBe("");
    expect(state.draft).toBeNull();
    expect(state.created).toBeNull();
    expect(state.activeRequestId).toBe("r2");
  });

  test("agent chunks accumulate only for the active request", () => {
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "agent-chunk", requestId: "r1", chunk: "a" },
      { type: "agent-chunk", requestId: "stale", chunk: "X" },
      { type: "agent-chunk", requestId: "r1", chunk: "b" },
    ]);
    expect(state.agentLog).toBe("ab");
  });

  test("edit failure returns to preview on dismiss, keeping the draft", () => {
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "generate-succeeded", draft },
      { type: "edit-started", requestId: "r2" },
      { type: "request-failed", error },
      { type: "error-dismissed" },
    ]);
    expect(state.phase).toBe("preview");
    expect(state.draft).toEqual(draft);
    expect(state.error).toBeNull();
  });

  test("decompose failure dismisses to done, not preview (task already created)", () => {
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "generate-succeeded", draft },
      { type: "create-started" },
      {
        type: "create-succeeded",
        created: {
          key: "T-1",
          url: "u",
          epicLinked: false,
          labelsApplied: false,
          attachmentsUploaded: 0,
        },
      },
      { type: "decompose-started", requestId: "r2" },
      { type: "request-failed", error },
      { type: "error-dismissed" },
    ]);
    expect(state.phase).toBe("done");
    expect(state.created?.key).toBe("T-1");
  });

  test("generate failure dismisses to idle when no draft exists", () => {
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "request-failed", error },
      { type: "error-dismissed" },
    ]);
    expect(state.phase).toBe("idle");
  });

  test("decompose flow selects all subtasks by default and supports toggling", () => {
    const subtasks = [{ summary: "A" }, { summary: "B" }, { summary: "C" }];
    let state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "generate-succeeded", draft },
      { type: "create-started" },
      {
        type: "create-succeeded",
        created: {
          key: "T-1",
          url: "u",
          epicLinked: false,
          labelsApplied: false,
          attachmentsUploaded: 0,
        },
      },
      { type: "decompose-started", requestId: "r2" },
      { type: "decompose-succeeded", subtasks },
    ]);
    expect(state.phase).toBe("subtask-review");
    expect([...state.selectedSubtasks].sort()).toEqual([0, 1, 2]);

    state = outputReducer(state, { type: "subtask-toggled", index: 1 });
    expect(state.selectedSubtasks.has(1)).toBe(false);
    expect(state.selectedSubtasks.size).toBe(2);

    state = run(
      [
        { type: "create-subtasks-started" },
        {
          type: "create-subtasks-finished",
          outcomes: [{ subtask: subtasks[0]!, key: "T-2", url: "u2" }],
        },
      ],
      state,
    );
    expect(state.phase).toBe("done");
    expect(state.subtaskOutcomes).toHaveLength(1);
    // The created task from before decomposition is still shown
    expect(state.created?.key).toBe("T-1");
  });

  test("edit-succeeded replaces the entire draft", () => {
    const userTitle = "User-edited title";
    const editedDraft = {
      summary: "AI-returned summary",
      description: "## AI revision\n\nUpdated acceptance criteria.",
    };
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "generate-succeeded", draft },
      { type: "draft-title-changed", summary: userTitle },
      { type: "edit-started", requestId: "r2" },
      { type: "edit-succeeded", draft: editedDraft },
    ]);
    expect(state.phase).toBe("preview");
    expect(state.activeRequestId).toBeNull();
    expect(state.draft?.summary).toBe(editedDraft.summary);
    expect(state.draft?.summary).not.toBe(userTitle);
    expect(state.draft?.description).toBe(editedDraft.description);
  });

  test("draft title stays editable in preview", () => {
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "generate-succeeded", draft },
      { type: "draft-title-changed", summary: "Better title" },
    ]);
    expect(state.draft?.summary).toBe("Better title");
    expect(state.draft?.description).toBe(draft.description);
  });

  test("draft description stays editable in preview without touching the title", () => {
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "generate-succeeded", draft },
      { type: "draft-description-changed", description: "## Overview\n\nPolished body" },
    ]);
    expect(state.draft?.description).toBe("## Overview\n\nPolished body");
    expect(state.draft?.summary).toBe(draft.summary);
  });

  test("draft description change is a no-op without a draft", () => {
    const state = outputReducer(initialOutputState, {
      type: "draft-description-changed",
      description: "orphan",
    });
    expect(state.draft).toBeNull();
  });

  test("empty description edits are allowed", () => {
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "generate-succeeded", draft },
      { type: "draft-description-changed", description: "" },
    ]);
    expect(state.draft?.description).toBe("");
  });

  test("restart resets everything", () => {
    const state = run([
      { type: "generate-started", requestId: "r1" },
      { type: "generate-succeeded", draft },
      { type: "restarted" },
    ]);
    expect(state).toEqual(initialOutputState);
  });
});
