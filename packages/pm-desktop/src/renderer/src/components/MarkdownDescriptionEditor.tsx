import { useEffect, useRef } from "react";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  codeBlockPlugin,
  CodeToggle,
  CreateLink,
  diffSourcePlugin,
  DiffSourceToggleWrapper,
  headingsPlugin,
  InsertTable,
  InsertThematicBreak,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  Separator,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
} from "@mdxeditor/editor";
import type { MDXEditorMethods } from "@mdxeditor/editor";
// oxlint-disable-next-line import/no-unassigned-import -- MDXEditor base styles
import "@mdxeditor/editor/style.css";

interface MarkdownDescriptionEditorProps {
  /** Canonical Markdown body (source of truth in draft state). */
  markdown: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}

/** Align with MDXEditor setMarkdown / export, which compare via `.trim()`. */
function isTrimEqual(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

const plugins = [
  toolbarPlugin({
    toolbarContents: () => (
      <DiffSourceToggleWrapper>
        <UndoRedo />
        <Separator />
        <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
        <CodeToggle />
        <Separator />
        <ListsToggle />
        <BlockTypeSelect />
        <CreateLink />
        <InsertTable />
        <InsertThematicBreak />
      </DiffSourceToggleWrapper>
    ),
  }),
  headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
  listsPlugin(),
  quotePlugin(),
  thematicBreakPlugin(),
  linkPlugin(),
  linkDialogPlugin(),
  tablePlugin(),
  // Plain fenced-code editor — avoids CodeMirror language packs in Electron.
  codeBlockPlugin({ defaultCodeBlockLanguage: "txt" }),
  diffSourcePlugin({ viewMode: "rich-text", diffMarkdown: "" }),
  markdownShortcutPlugin(),
];
/**
 * WYSIWYG Markdown editor for story descriptions.
 *
 * MDXEditor treats `markdown` like a defaultValue — external updates (e.g. AI
 * edit success) must go through `setMarkdown`. Local typing updates draft
 * state via `onChange` without remounting.
 *
 * Mount-time exports set `initialMarkdownNormalize` (often more than once) and
 * may restyle bullets / trim. When that settled export diverges from the prop,
 * forward it once so Create persists the Markdown the user reviewed.
 * `setMarkdown` is muteChange'd by the library and does not notify `onChange`.
 *
 * Descriptions are user-controlled rich text persisted to third-party trackers
 * on task creation; MDXEditor HTML processing stays enabled so raw HTML is not
 * passed through unsanitized.
 */
export function MarkdownDescriptionEditor({
  markdown,
  onChange,
  readOnly = false,
  placeholder = "Write the story description…",
}: MarkdownDescriptionEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  /** Last `markdown` prop value we observed from the parent. */
  const lastPropRef = useRef(markdown);
  /**
   * Last Markdown emitted by the editor or applied via setMarkdown — may be
   * editor-normalized and diverge from the prop until parent catches up.
   */
  const lastSyncedRef = useRef(markdown);

  useEffect(() => {
    // Only react to real prop changes — not mount echoes that update lastSyncedRef
    // before this effect runs (child effects fire first).
    if (markdown === lastPropRef.current) return;
    lastPropRef.current = markdown;
    if (isTrimEqual(markdown, lastSyncedRef.current)) return;
    lastSyncedRef.current = markdown;
    // Real MDXEditor mutes onChange around setMarkdown — no suppress needed.
    editorRef.current?.setMarkdown(markdown);
  }, [markdown]);

  return (
    <MDXEditor
      ref={editorRef}
      className="draft-mdx-editor mdxeditor-full-height"
      contentEditableClassName="prose-preview draft-mdx-content"
      markdown={markdown}
      readOnly={readOnly}
      placeholder={placeholder}
      toMarkdownOptions={{ bullet: "-" }}
      plugins={plugins}
      onChange={(value, initialMarkdownNormalize) => {
        if (initialMarkdownNormalize) {
          lastSyncedRef.current = value;
          // Canonicalize draft to the editor export so persisted text matches UI.
          if (!readOnly && !isTrimEqual(value, lastPropRef.current)) {
            onChange(value);
          }
          return;
        }
        if (isTrimEqual(value, lastSyncedRef.current)) {
          lastSyncedRef.current = value;
          return;
        }
        lastSyncedRef.current = value;
        if (readOnly) return;
        onChange(value);
      }}
    />
  );
}
