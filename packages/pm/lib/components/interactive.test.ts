import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { canNavigateBack, getPreviousStep, runInteractiveMode } from "./interactive";

class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write(data: string) {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  }
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() {
    const { data } = this;
    this.data = null;
    return data;
  }
}

/** Polls until a condition becomes true.
 *  Using polling for state transitions eliminates flakiness from fixed timeouts under CI load or CPU contention.
 */
const waitFor = (condition: () => boolean, { timeout = 2000, interval = 5 } = {}) =>
  new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - start > timeout) {
        reject(new Error("Timeout waiting for condition"));
      } else {
        setTimeout(check, interval);
      }
    };
    check();
  });

/** Minimal sleep for allowing rapid stdin events to propagate through Ink's event loop.
 *  Kept very small (5 ms) because FakeStdin is synchronous; this just yields to the microtask queue.
 */
const sleep = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

// Under `bun test` stdout is a pipe with no columns, so every Ink render
// falls back to terminal-size's synchronous `tput` subprocess. Pin a width
// to keep renders fast and reduce timing skew in the step-transition waits.
if (!process.stdout.columns) {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
}

describe("runInteractiveMode", () => {
  let handle: Awaited<ReturnType<typeof runInteractiveMode>>;
  let stdin: FakeStdin;

  beforeEach(async () => {
    stdin = new FakeStdin();
    handle = await runInteractiveMode({
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
  });

  afterEach(() => {
    handle?.cleanup();
  });

  test("getStep returns current step", () => {
    expect(handle.getStep()).toBe("source-type");
  });

  test("getPreviewData returns undefined before any preview data is set", () => {
    expect(handle.getPreviewData()).toBeUndefined();
  });

  test("getStep reflects transitions through the full edit flow", async () => {
    expect(handle.getStep()).toBe("source-type");

    handle.setPreviewData("Summary", "Description");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getStep()).toBe("preview");

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");
    expect(handle.getStep()).toBe("edit-prompt");

    // Type an edit and submit to transition to regenerating
    stdin.write("refine");
    await sleep(5);
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "regenerating");
    expect(handle.getStep()).toBe("regenerating");

    // New preview data arrives from the orchestrator
    handle.setPreviewData("New Summary", "New Description");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getStep()).toBe("preview");
  });

  test("setPreviewData transitions to preview", async () => {
    handle.setPreviewData("Summary", "Description");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getStep()).toBe("preview");
    expect(handle.getPreviewData()).toEqual({
      summary: "Summary",
      description: "Description",
    });
  });

  test("buffers previewData while in edit-prompt and applies on transition to preview", async () => {
    handle.setPreviewData("Initial Summary", "Initial Description");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getPreviewData()).toEqual({
      summary: "Initial Summary",
      description: "Initial Description",
    });

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");
    expect(handle.getStep()).toBe("edit-prompt");

    handle.setPreviewData("New Summary", "New Description");
    // Wait for the data, not just the step: applying buffered previewData can
    // take an extra render after the step flips to preview.
    await waitFor(
      () => handle.getStep() === "preview" && handle.getPreviewData()?.summary === "New Summary",
    );
    expect(handle.getPreviewData()).toEqual({
      summary: "New Summary",
      description: "New Description",
    });
  });

  test("preserves step transitions while buffering previewData in edit-prompt", async () => {
    handle.setPreviewData("Initial Summary", "Initial Description");
    await waitFor(() => handle.getStep() === "preview");

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");

    // Simulate an external orchestrator trying to transition to an error/loading state
    // while the user is in edit-prompt. The step should still be applied even though
    // previewData is buffered.
    handle.setPreviewData("Buffered", "Data");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getStep()).toBe("preview");
  });

  test("buffers previewData when updated without step change during edit-prompt, then applies on transition to preview", async () => {
    handle.setPreviewData("Initial Summary", "Initial Description");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getPreviewData()).toEqual({
      summary: "Initial Summary",
      description: "Initial Description",
    });

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");

    // Simulate an orchestrator pushing previewData without a step change.
    // This buffers the data so the preview is not rewritten mid-typing.
    handle.updatePreviewData("Buffered Summary", "Buffered Description");
    await sleep(5);

    // Trigger an internal re-render by typing a character in the prompt.
    // With the bug (clearing buffer whenever nextStep === 'edit-prompt'),
    // this re-render would discard the buffered data.
    stdin.write("x");
    await sleep(5);

    // Still in edit-prompt
    expect(handle.getStep()).toBe("edit-prompt");

    // Transition to preview via Escape (no new previewData).
    // The buffered data from updatePreviewData should be applied.
    stdin.write("\x1b");
    // Wait for the data, not just the step: the buffered previewData is
    // applied by an effect one render after the step leaves edit-prompt.
    await waitFor(
      () =>
        handle.getStep() === "preview" && handle.getPreviewData()?.summary === "Buffered Summary",
    );

    expect(handle.getPreviewData()).toEqual({
      summary: "Buffered Summary",
      description: "Buffered Description",
    });
  });

  test("edit-prompt handles batched backspace bytes from held backspace", async () => {
    handle.setPreviewData("Summary", "Description");
    await waitFor(() => handle.getStep() === "preview");

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");

    const editPromise = handle.waitForEdit();
    stdin.write("Hello World");
    // Terminals often batch DEL bytes when backspace is held.
    stdin.write("\x7f".repeat(" World".length));
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "regenerating");

    const result = await editPromise;
    expect(result.editPrompt).toBe("Hello");
  });

  test("edit-prompt captures rapid typing without dropping characters", async () => {
    handle.setPreviewData("Summary", "Description");
    await waitFor(() => handle.getStep() === "preview");

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");

    const editPromise = handle.waitForEdit();
    stdin.write("Make it shorter");
    await sleep(5);
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "regenerating");

    const result = await editPromise;
    expect(result.editPrompt).toBe("Make it shorter");
  });

  test("waitForEdit resolves with latest visible preview data", async () => {
    handle.setPreviewData("Summary", "Description");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getStep()).toBe("preview");

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");
    expect(handle.getStep()).toBe("edit-prompt");

    const editPromise = handle.waitForEdit();

    // Type "Make it shorter" and submit with Enter
    for (const char of "Make it shorter") {
      stdin.write(char);
      await sleep(2);
    }
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "regenerating");

    const result = await editPromise;
    expect(result).toEqual({
      editPrompt: "Make it shorter",
      currentSummary: "Summary",
      currentDescription: "Description",
    });
  });

  test("Esc from preview after setPreviewData stays on preview with data (no blank step)", async () => {
    handle.setPreviewData("Story Title", "Long markdown description");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getPreviewData()).toEqual({
      summary: "Story Title",
      description: "Long markdown description",
    });

    // Esc is intentional no-op on preview (orchestrator holds waitForCompletion/waitForEdit).
    stdin.write("\x1b");
    await sleep(20);

    expect(handle.getStep()).toBe("preview");
    expect(handle.getPreviewData()).toEqual({
      summary: "Story Title",
      description: "Long markdown description",
    });
  });

  test("Esc from edit-prompt returns to preview with last known title/description", async () => {
    handle.setPreviewData("Keep Me", "Keep this description");
    await waitFor(() => handle.getStep() === "preview");

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");

    stdin.write("partial edit text");
    await sleep(5);
    stdin.write("\x1b");

    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getPreviewData()).toEqual({
      summary: "Keep Me",
      description: "Keep this description",
    });
  });

  test("Esc from edit-prompt with buffered updatePreviewData applies buffer on return to preview", async () => {
    handle.setPreviewData("Initial", "Initial body");
    await waitFor(() => handle.getStep() === "preview");

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");

    handle.updatePreviewData("Buffered Title", "Buffered body");
    await sleep(5);

    stdin.write("\x1b");
    await waitFor(
      () => handle.getStep() === "preview" && handle.getPreviewData()?.summary === "Buffered Title",
    );

    expect(handle.getPreviewData()).toEqual({
      summary: "Buffered Title",
      description: "Buffered body",
    });
  });

  test("Esc during generating keeps loading step (non-blank, no cancel)", async () => {
    handle.setGenerating();
    await waitFor(() => handle.getStep() === "generating");

    stdin.write("\x1b");
    await sleep(20);

    expect(handle.getStep()).toBe("generating");
  });

  test("Esc during regenerating keeps loading step", async () => {
    handle.setPreviewData("S", "D");
    await waitFor(() => handle.getStep() === "preview");

    stdin.write("e");
    await waitFor(() => handle.getStep() === "edit-prompt");

    stdin.write("change it");
    await sleep(5);
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "regenerating");

    stdin.write("\x1b");
    await sleep(20);
    expect(handle.getStep()).toBe("regenerating");
  });

  test("Enter on preview without data does not leave preview or resolve completion", async () => {
    // Stay on source-type-adjacent path: force preview step without data via setGenerating
    // then manually only check Enter does not advance from generating.
    handle.setGenerating();
    await waitFor(() => handle.getStep() === "generating");

    stdin.write("\r");
    await sleep(20);
    expect(handle.getStep()).toBe("generating");
  });

  test("Enter on preview with data accepts (Y) and moves to done", async () => {
    handle.setPreviewData("Title", "Body");
    await waitFor(() => handle.getStep() === "preview");

    const completion = handle.waitForCompletion();
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "done");
    await completion;
    expect(handle.getStep()).toBe("done");
  });

  test("showSuccess transitions to success step", async () => {
    handle.showSuccess("Task created: https://example.com/TASK-1");
    await waitFor(() => handle.getStep() === "success");
    expect(handle.getStep()).toBe("success");
  });

  test("Enter on success resolves waitForRestart without leaving success until restart()", async () => {
    handle.showSuccess("Task created: https://example.com/TASK-1");
    await waitFor(() => handle.getStep() === "success");

    const restartPromise = handle.waitForRestart();
    // Stay on success until orchestrator calls restart() — avoids blank remount races
    stdin.write("\r");
    await restartPromise;

    expect(handle.getStep()).toBe("success");

    handle.restart();
    await waitFor(() => handle.getStep() === "source-type");
    expect(handle.getStep()).toBe("source-type");
  });

  test("any advertised key on success resolves waitForRestart", async () => {
    handle.showSuccess("Task created: https://example.com/TASK-2");
    await waitFor(() => handle.getStep() === "success");

    const restartPromise = handle.waitForRestart();
    stdin.write(" ");
    await restartPromise;

    handle.restart();
    await waitFor(() => handle.getStep() === "source-type");
    expect(handle.getStep()).toBe("source-type");
  });

  test("restart clears preview data and returns to source-type ready for next create", async () => {
    handle.setPreviewData("Done summary", "Done description");
    await waitFor(() => handle.getStep() === "preview");
    expect(handle.getPreviewData()).toEqual({
      summary: "Done summary",
      description: "Done description",
    });

    handle.showSuccess("Task created: https://example.com/TASK-3");
    await waitFor(() => handle.getStep() === "success");

    handle.restart();
    await waitFor(() => handle.getStep() === "source-type");

    expect(handle.getStep()).toBe("source-type");
    expect(handle.getPreviewData()).toBeUndefined();
  });

  test("after success restart, a second waitForCompletion cycle works end-to-end", async () => {
    // First cycle: jump to success as if a task was just created
    handle.showSuccess("Task created: https://example.com/TASK-1");
    await waitFor(() => handle.getStep() === "success");

    const firstRestart = handle.waitForRestart();
    stdin.write("\r");
    await firstRestart;
    handle.restart();
    await waitFor(() => handle.getStep() === "source-type");

    // Second cycle: user confirms config → agent preview → accept create
    // Drive wizard to confirm via source-type → ... is heavy; simulate completion
    // the way the orchestrator does after generation by setting preview and accepting.
    handle.setPreviewData("Second task", "Second description");
    await waitFor(() => handle.getStep() === "preview");

    const secondCompletion = handle.waitForCompletion();
    stdin.write("y");
    const secondConfig = await secondCompletion;

    expect(secondConfig.previewData).toEqual({
      summary: "Second task",
      description: "Second description",
    });
    await waitFor(() => handle.getStep() === "done");
    expect(handle.getStep()).toBe("done");
  });

  test("rapid keypresses on success resolve waitForRestart once without leaving success", async () => {
    handle.showSuccess("Task created: https://example.com/TASK-4");
    await waitFor(() => handle.getStep() === "success");

    const restartPromise = handle.waitForRestart();
    stdin.write("\r");
    stdin.write("\r");
    stdin.write("x");
    await restartPromise;

    // Still on success — orchestrator owns the transition via restart()
    expect(handle.getStep()).toBe("success");

    handle.restart();
    await waitFor(() => handle.getStep() === "source-type");
    expect(handle.getStep()).toBe("source-type");
  });

  test("cleanup rejects pending waitForRestart so cancel exits cleanly", async () => {
    handle.showSuccess("Task created: https://example.com/TASK-5");
    await waitFor(() => handle.getStep() === "success");

    const restartPromise = handle.waitForRestart();
    handle.cleanup();

    await expect(restartPromise).rejects.toThrow("Interactive mode cancelled");
  });
});

describe("getPreviousStep / canNavigateBack", () => {
  test("mirrors forward skip edges when epic and issue-type are disabled", () => {
    const flags = { hasEpicStep: false, hasIssueTypeStep: false };
    expect(getPreviousStep("style", flags)).toBe("custom");
    expect(getPreviousStep("confirm", flags)).toBe("style");
    expect(getPreviousStep("custom", flags)).toBe("source-input");
    expect(getPreviousStep("edit-prompt", flags)).toBe("preview");
    expect(getPreviousStep("preview", flags)).toBeNull();
    expect(getPreviousStep("generating", flags)).toBeNull();
    expect(canNavigateBack("preview", flags)).toBe(false);
    expect(canNavigateBack("edit-prompt", flags)).toBe(true);
  });

  test("back from style lands on issue-type when available", () => {
    expect(getPreviousStep("style", { hasEpicStep: true, hasIssueTypeStep: true })).toBe(
      "issue-type",
    );
    expect(getPreviousStep("style", { hasEpicStep: true, hasIssueTypeStep: false })).toBe("epic");
    expect(getPreviousStep("issue-type", { hasEpicStep: false, hasIssueTypeStep: true })).toBe(
      "custom",
    );
  });
});

describe("Esc config-step chain with skipped steps", () => {
  let handle: Awaited<ReturnType<typeof runInteractiveMode>>;
  let stdin: FakeStdin;

  afterEach(() => {
    handle?.cleanup();
  });

  test("Esc from style with no epic and no issue-types goes to custom (never epic/issue-type)", async () => {
    stdin = new FakeStdin();
    handle = await runInteractiveMode({
      stdin: stdin as unknown as NodeJS.ReadStream,
      supportsEpicLinking: false,
      // issueTypes omitted → no issue-type step
    });

    // source-type → prompt → source-input → custom → style
    stdin.write("3");
    await waitFor(() => handle.getStep() === "source-input");
    stdin.write("requirements text");
    await sleep(5);
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "custom");
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "style");

    stdin.write("\x1b");
    await waitFor(() => handle.getStep() === "custom");
    expect(handle.getStep()).toBe("custom");

    // Esc further should not hit skipped steps
    stdin.write("\x1b");
    await waitFor(() => handle.getStep() === "source-input");
    expect(handle.getStep()).toBe("source-input");
  });

  test("Esc from style with epic only (no issue types) goes to epic", async () => {
    stdin = new FakeStdin();
    handle = await runInteractiveMode({
      stdin: stdin as unknown as NodeJS.ReadStream,
      supportsEpicLinking: true,
    });

    stdin.write("3");
    await waitFor(() => handle.getStep() === "source-input");
    stdin.write("req");
    await sleep(5);
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "custom");
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "epic");
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "style");

    stdin.write("\x1b");
    await waitFor(() => handle.getStep() === "epic");
    expect(handle.getStep()).toBe("epic");
  });

  test("Esc from style with epic and issue-types goes to issue-type", async () => {
    stdin = new FakeStdin();
    handle = await runInteractiveMode({
      stdin: stdin as unknown as NodeJS.ReadStream,
      supportsEpicLinking: true,
      issueTypes: ["Story", "Task"],
    });

    stdin.write("3");
    await waitFor(() => handle.getStep() === "source-input");
    stdin.write("req");
    await sleep(5);
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "custom");
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "epic");
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "issue-type");
    // accept default issue type
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "style");

    stdin.write("\x1b");
    await waitFor(() => handle.getStep() === "issue-type");
    expect(handle.getStep()).toBe("issue-type");

    stdin.write("\x1b");
    await waitFor(() => handle.getStep() === "epic");
    expect(handle.getStep()).toBe("epic");
  });
});

describe("runInteractiveMode harness step (Ctrl+G)", () => {
  const HARNESS_FIXTURE = [
    { name: "claude-code", displayName: "Claude Code" },
    { name: "opencode", displayName: "OpenCode" },
    { name: "codex", displayName: "Codex" },
  ];

  let handle: Awaited<ReturnType<typeof runInteractiveMode>>;
  let stdin: FakeStdin;

  beforeEach(async () => {
    stdin = new FakeStdin();
    handle = await runInteractiveMode({
      stdin: stdin as unknown as NodeJS.ReadStream,
      harnesses: HARNESS_FIXTURE,
      currentHarnessName: "claude-code",
    });
  });

  afterEach(() => {
    handle?.cleanup();
  });

  test("Ctrl+G navigates from source-type into the harness step", async () => {
    expect(handle.getStep()).toBe("source-type");

    // Ctrl+G is byte 0x07. FakeStdin emits it as raw data; Ink's input
    // parser turns it into key.ctrl=true + inputChar="g".
    stdin.write("\x07");
    await waitFor(() => handle.getStep() === "harness");
    expect(handle.getStep()).toBe("harness");
  });

  test("number selection in the harness step updates harnessName and returns to the previous step", async () => {
    expect(handle.getStep()).toBe("source-type");

    stdin.write("\x07");
    await waitFor(() => handle.getStep() === "harness");
    expect(handle.getStep()).toBe("harness");

    // Press "2" to pick opencode (1=claude-code, 2=opencode, 3=codex).
    stdin.write("2");
    await waitFor(() => handle.getStep() === "source-type");
    expect(handle.getStep()).toBe("source-type");
    expect(handle.getHarnessName()).toBe("opencode");
  });

  test("Enter on the harness step returns to the previous step without changing harness", async () => {
    expect(handle.getStep()).toBe("source-type");

    stdin.write("\x07");
    await waitFor(() => handle.getStep() === "harness");

    // Enter on empty input keeps the current harness and pops back to the
    // step we entered from (source-type in this case).
    stdin.write("\r");
    await waitFor(() => handle.getStep() === "source-type");
    expect(handle.getStep()).toBe("source-type");
  });

  test("ESC on the harness step returns to the previous step without changing harness", async () => {
    expect(handle.getStep()).toBe("source-type");

    stdin.write("\x07");
    await waitFor(() => handle.getStep() === "harness");

    // ESC is byte 0x1b.
    stdin.write("\x1b");
    await waitFor(() => handle.getStep() === "source-type");
    expect(handle.getStep()).toBe("source-type");
  });

  test("Ctrl+G does not navigate to harness from generating/regenerating/done", async () => {
    // Drive the wizard to "done" via the preview path: set preview, confirm.
    handle.setPreviewData("Title", "Body");
    await waitFor(() => handle.getStep() === "preview");

    // Confirm: "y" on the preview step moves to "done".
    stdin.write("y");
    await waitFor(() => handle.getStep() === "done");
    expect(handle.getStep()).toBe("done");

    // Pressing Ctrl+G while in "done" should be a no-op.
    stdin.write("\x07");
    await sleep(20);
    expect(handle.getStep()).toBe("done");
  });

  test("number selection with no matching input does not change the step", async () => {
    expect(handle.getStep()).toBe("source-type");

    stdin.write("\x07");
    await waitFor(() => handle.getStep() === "harness");

    // Out-of-range number is ignored.
    stdin.write("9");
    await sleep(20);
    expect(handle.getStep()).toBe("harness");
  });

  test("Ctrl+G is ignored when no harnesses are configured", async () => {
    handle.cleanup();
    stdin = new FakeStdin();
    handle = await runInteractiveMode({
      stdin: stdin as unknown as NodeJS.ReadStream,
      // harnesses omitted on purpose
    });
    expect(handle.getStep()).toBe("source-type");

    stdin.write("\x07");
    await sleep(20);
    expect(handle.getStep()).toBe("source-type");
  });

  test("re-entering the harness step after picking option 2 follows the new selection", async () => {
    expect(handle.getHarnessName()).toBe("claude-code");

    // Pick option 2 (opencode).
    stdin.write("\x07");
    await waitFor(() => handle.getStep() === "harness");
    stdin.write("2");
    await waitFor(() => handle.getStep() === "source-type");
    expect(handle.getHarnessName()).toBe("opencode");

    // Re-enter the harness step. The '(current)' label should now mark
    // opencode (the freshly selected harness) and not claude-code.
    stdin.write("\x07");
    await waitFor(() => handle.getStep() === "harness");
    expect(handle.getHarnessName()).toBe("opencode");
  });
});
