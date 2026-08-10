import { describe, expect, test } from "bun:test";
import { attachmentRejectReason, mergeAttachments } from "./attachments.ts";

describe("attachmentRejectReason", () => {
  test("allows markdown and images", () => {
    expect(attachmentRejectReason("notes.md")).toBeNull();
    expect(attachmentRejectReason("ui.PNG")).toBeNull();
  });

  test("rejects docx", () => {
    expect(attachmentRejectReason("brief.docx")).toContain("export to");
  });
});

describe("mergeAttachments", () => {
  test("dedupes and caps", () => {
    const first = mergeAttachments(
      [],
      [
        { path: "/a/notes.md", name: "notes.md" },
        { path: "/a/notes.md", name: "notes.md" },
      ],
    );
    expect(first.next).toHaveLength(1);

    const many = Array.from({ length: 12 }, (_, i) => ({
      path: `/tmp/f${i}.md`,
      name: `f${i}.md`,
    }));
    const capped = mergeAttachments([], many);
    expect(capped.next).toHaveLength(10);
    expect(capped.error).toContain("Maximum");
  });
});
