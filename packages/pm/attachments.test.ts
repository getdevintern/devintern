import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachmentExtensionError,
  cleanupAttachmentStaging,
  isAllowedAttachmentExtension,
  stageAttachments,
  validateAttachmentFile,
} from "./lib/attachments.js";
import { MarkdownBackend } from "./lib/backends/markdown.js";

describe("attachment allowlist", () => {
  test("allows text and images", () => {
    expect(isAllowedAttachmentExtension("notes.md")).toBe(true);
    expect(isAllowedAttachmentExtension("shot.PNG")).toBe(true);
    expect(isAllowedAttachmentExtension("spec.pdf")).toBe(true);
  });

  test("rejects office binaries", () => {
    expect(attachmentExtensionError("brief.docx")).toContain("export to");
    expect(isAllowedAttachmentExtension("sheet.xlsx")).toBe(false);
  });
});

describe("stageAttachments", () => {
  test("copies files into a temp dir", async () => {
    const srcDir = await mkdtemp(join(tmpdir(), "devpm-attach-src-"));
    const md = join(srcDir, "notes.md");
    const png = join(srcDir, "ui.png");
    writeFileSync(md, "# hello");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const staged = await stageAttachments([{ path: md }, { path: png, name: "UI.png" }]);

    expect(staged.files).toHaveLength(2);
    expect(staged.files[0]?.kind).toBe("file");
    expect(staged.files[1]?.kind).toBe("image");
    expect(staged.files[1]?.name).toBe("UI.png");

    await cleanupAttachmentStaging(staged.dir);
  });

  test("rejects missing files", async () => {
    await expect(validateAttachmentFile("/tmp/does-not-exist-devpm.md")).rejects.toThrow(
      "file not found",
    );
  });
});

describe("MarkdownBackend.uploadAttachment", () => {
  test("copies file and links it in the issue body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devpm-md-attach-"));
    mkdirSync(dir, { recursive: true });
    const backend = new MarkdownBackend({ directory: dir });
    const task = await backend.createTask("Feature", "Body", "Task");

    const src = join(dir, "roadmap.md");
    writeFileSync(src, "Q3 goals");
    await backend.uploadAttachment(task.key, src, { filename: "roadmap.md" });

    const content = await Bun.file(join(dir, `${task.key}.md`)).text();
    expect(content).toContain("## Attachments");
    expect(content).toContain(`attachments/${task.key}/roadmap.md`);
    expect(await Bun.file(join(dir, "attachments", task.key, "roadmap.md")).exists()).toBe(true);
  });
});
