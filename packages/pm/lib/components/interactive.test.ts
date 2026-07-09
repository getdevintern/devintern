import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { runInteractiveMode } from "./interactive";

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
const waitFor = (condition: () => boolean, { timeout = 2000, interval = 10 } = {}) =>
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
    await sleep(30);
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
    await waitFor(() => handle.getStep() === "preview");
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
    await sleep(30);

    // Trigger an internal re-render by typing a character in the prompt.
    // With the bug (clearing buffer whenever nextStep === 'edit-prompt'),
    // this re-render would discard the buffered data.
    stdin.write("x");
    await sleep(30);

    // Still in edit-prompt
    expect(handle.getStep()).toBe("edit-prompt");

    // Transition to preview via Escape (no new previewData).
    // The buffered data from updatePreviewData should be applied.
    stdin.write("\x1b");
    await waitFor(() => handle.getStep() === "preview");

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
    await sleep(30);
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
      await sleep(30);
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
});
