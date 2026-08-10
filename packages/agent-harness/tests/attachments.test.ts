import { describe, expect, test } from "bun:test";

import {
  appendAttachmentPathsToPrompt,
  attachmentKindForPath,
  isImagePath,
  preparePromptWithAttachments,
} from "../src/attachments.js";
import { ClaudeCodeHarness } from "../src/harnesses/claude-code.js";
import { CodexHarness } from "../src/harnesses/codex.js";
import { buildPromptArgs } from "../src/prompt-args.js";

describe("isImagePath", () => {
  test("detects common image extensions", () => {
    expect(isImagePath("/tmp/shot.PNG")).toBe(true);
    expect(isImagePath("diagram.jpeg")).toBe(true);
    expect(isImagePath("a.webp")).toBe(true);
  });

  test("rejects non-images", () => {
    expect(isImagePath("/tmp/notes.md")).toBe(false);
    expect(isImagePath("archive")).toBe(false);
  });
});

describe("appendAttachmentPathsToPrompt", () => {
  test("returns prompt unchanged when empty", () => {
    expect(appendAttachmentPathsToPrompt("Hello", [])).toBe("Hello");
  });

  test("formats images and files, deduping paths", () => {
    const result = appendAttachmentPathsToPrompt("Draft a story", [
      { path: "/tmp/ui.png", name: "UI" },
      { path: "/tmp/notes.md" },
      { path: "/tmp/ui.png", name: "duplicate" },
    ]);

    expect(result).toContain("## Attached files");
    expect(result).toContain("![UI](/tmp/ui.png)");
    expect(result).toContain("[notes.md](/tmp/notes.md)");
    expect(result.match(/\/tmp\/ui\.png/g)?.length).toBe(1);
  });
});

describe("preparePromptWithAttachments", () => {
  test("path-mode harnesses inject prompt paths without image args", () => {
    const { prompt, imageArgs } = preparePromptWithAttachments(
      new ClaudeCodeHarness(),
      "Write AC",
      {
        attachmentPaths: ["/tmp/spec.md", "/tmp/shot.png"],
        imagePaths: ["/tmp/shot.png"],
      },
    );

    expect(prompt).toContain("[spec.md](/tmp/spec.md)");
    expect(prompt).toContain("![shot.png](/tmp/shot.png)");
    expect(imageArgs).toEqual([]);
  });

  test("Codex native mode appends -i after prompt args", () => {
    const codex = new CodexHarness();
    const { prompt, imageArgs } = preparePromptWithAttachments(codex, "Describe", {
      attachmentPaths: ["/tmp/a.png", "/tmp/notes.txt"],
      imagePaths: ["/tmp/a.png", "/tmp/b.png"],
    });

    expect(prompt).toContain("/tmp/a.png");
    expect(prompt).toContain("/tmp/notes.txt");
    expect(prompt).toContain("/tmp/b.png");
    expect(imageArgs).toEqual(["-i", "/tmp/a.png", "-i", "/tmp/b.png"]);

    const args = [
      ...codex.buildArgs({ skipPermissions: true }),
      ...buildPromptArgs(codex, prompt),
      ...imageArgs,
    ];
    const promptIndex = args.indexOf(prompt);
    expect(promptIndex).toBeGreaterThan(-1);
    expect(args.slice(promptIndex + 1)).toEqual(["-i", "/tmp/a.png", "-i", "/tmp/b.png"]);
  });
});

describe("attachmentKindForPath", () => {
  test("classifies by extension", () => {
    expect(attachmentKindForPath("x.png")).toBe("image");
    expect(attachmentKindForPath("x.md")).toBe("file");
  });
});

describe("CodexHarness.buildImageArgs", () => {
  test("emits repeated -i flags", () => {
    const h = new CodexHarness();
    expect(h.imageInput).toBe("native");
    expect(h.buildImageArgs(["/a.png", " ", "/b.jpg"])).toEqual([
      "-i",
      "/a.png",
      "-i",
      "/b.jpg",
    ]);
  });
});
