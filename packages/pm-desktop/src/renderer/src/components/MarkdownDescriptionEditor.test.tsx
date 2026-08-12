import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { Ref } from "react";
import type { MDXEditorMethods } from "@mdxeditor/editor";

type MockEditorProps = {
  markdown: string;
  readOnly?: boolean;
  onChange?: (value: string, initialMarkdownNormalize: boolean) => void;
  ref?: Ref<MDXEditorMethods>;
};

let mockSetMarkdown: ReturnType<typeof mock>;
let lastEditorProps: MockEditorProps | null;
/** When true, mount normalization fires via queueMicrotask instead of sync useEffect. */
let asyncMountNormalization = false;
/**
 * When set, the second mount normalize call uses this value (with
 * initialMarkdownNormalize=true) instead of a trailing-newline echo.
 */
let mountSecondNormalize: string | null = null;

/** Match MarkdownDescriptionEditor `toMarkdownOptions.bullet: "-"`. */
function normalizeLikeMdxEditor(markdown: string): string {
  return markdown.trim().replace(/^\* /gm, "- ");
}

mock.module("@mdxeditor/editor", () => {
  const React = require("react");
  const { forwardRef, useEffect, useImperativeHandle } = React;

  const MDXEditor = forwardRef(function MockMDXEditor(
    props: MockEditorProps,
    ref: Ref<MDXEditorMethods>,
  ) {
    lastEditorProps = props;
    useImperativeHandle(ref, () => ({
      setMarkdown: (value: string) => {
        mockSetMarkdown(value);
        // Real MDXEditor sets muteChange$ around editor.update — no onChange.
      },
      getMarkdown: () => props.markdown,
      focus: () => {},
      insertMarkdown: () => {},
    }));

    // Capture mount-time props in refs so the effect stays mount-only and does
    // not depend on prop identities that change every parent render.
    const markdownAtMountRef = React.useRef(props.markdown);
    const onChangeAtMountRef = React.useRef(props.onChange);
    useEffect(() => {
      // Simulate MDXEditor mount: markdown$ publish, then Lexical export trim /
      // bullet restyle, both with initialMarkdownNormalize=true.
      const first = markdownAtMountRef.current;
      const second = mountSecondNormalize ?? normalizeLikeMdxEditor(first);
      const onChange = onChangeAtMountRef.current;
      const fire = () => {
        onChange?.(first, true);
        onChange?.(second, true);
      };
      if (asyncMountNormalization) {
        queueMicrotask(fire);
        return;
      }
      fire();
    }, []);

    return React.createElement("div", { "data-testid": "mock-mdx-editor" });
  });

  return {
    MDXEditor,
    BlockTypeSelect: () => null,
    BoldItalicUnderlineToggles: () => null,
    CodeToggle: () => null,
    CreateLink: () => null,
    DiffSourceToggleWrapper: ({ children }: { children: unknown }) => children,
    InsertTable: () => null,
    InsertThematicBreak: () => null,
    ListsToggle: () => null,
    Separator: () => null,
    UndoRedo: () => null,
    codeBlockPlugin: () => ({}),
    diffSourcePlugin: () => ({}),
    headingsPlugin: () => ({}),
    linkDialogPlugin: () => ({}),
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
    toolbarPlugin: () => ({}),
  };
});

mock.module("@mdxeditor/editor/style.css", () => ({}));

const { MarkdownDescriptionEditor } = await import("./MarkdownDescriptionEditor.tsx");

describe("MarkdownDescriptionEditor", () => {
  let domWindow: Window;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    domWindow = new Window();
    const { document } = domWindow;
    globalThis.document = document as unknown as Document;
    globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
    // React 19 act() integration for non-RTL test environments.
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

    mockSetMarkdown = mock(() => {});
    lastEditorProps = null;
    asyncMountNormalization = false;
    mountSecondNormalize = null;
    container = document.createElement("div") as unknown as HTMLDivElement;
    document.body.appendChild(
      container as unknown as Parameters<typeof document.body.appendChild>[0],
    );
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // @ts-expect-error test teardown
    delete globalThis.document;
    // @ts-expect-error test teardown
    delete globalThis.window;
    domWindow.close();
  });

  function renderEditor(props: {
    markdown: string;
    onChange: ReturnType<typeof mock>;
    readOnly?: boolean;
  }) {
    act(() => {
      root.render(
        <MarkdownDescriptionEditor
          markdown={props.markdown}
          onChange={props.onChange}
          readOnly={props.readOnly}
        />,
      );
    });
  }

  test("does not forward trim-only mount normalization to parent state", () => {
    const onChange = mock(() => {});
    renderEditor({ markdown: "## Draft body", onChange });

    expect(onChange).not.toHaveBeenCalled();
    expect(mockSetMarkdown).not.toHaveBeenCalled();
  });

  test("forwards mount-time bullet restyle so draft matches reviewed Markdown", () => {
    const onChange = mock(() => {});
    // Second Lexical export differs by leading trim + bullet restyle, not only trimEnd.
    mountSecondNormalize = "- item";
    renderEditor({ markdown: "  * item", onChange });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("- item");
    expect(mockSetMarkdown).not.toHaveBeenCalled();
  });

  test("forwards delayed mount-time normalization to parent state", async () => {
    asyncMountNormalization = true;
    mountSecondNormalize = "- item";
    const onChange = mock(() => {});
    renderEditor({ markdown: "  * item", onChange });

    await act(async () => {
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("- item");
    expect(mockSetMarkdown).not.toHaveBeenCalled();
  });

  test("forwards user edits when not read-only", () => {
    const onChange = mock(() => {});
    renderEditor({ markdown: "Hello", onChange });

    act(() => {
      lastEditorProps?.onChange?.("Hello world", false);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Hello world");
  });

  test("ignores onChange while read-only", () => {
    const onChange = mock(() => {});
    renderEditor({ markdown: "Hello", onChange, readOnly: true });

    act(() => {
      lastEditorProps?.onChange?.("Leaked edit", false);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  test("forwards user edits after leaving read-only", () => {
    const onChange = mock(() => {});
    renderEditor({ markdown: "Hello", onChange, readOnly: true });

    act(() => {
      root.render(
        <MarkdownDescriptionEditor markdown="Hello" onChange={onChange} readOnly={false} />,
      );
    });

    act(() => {
      lastEditorProps?.onChange?.("Hello world", false);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Hello world");
  });

  test("syncs external markdown updates via setMarkdown without feedback loop", () => {
    const onChange = mock(() => {});
    renderEditor({ markdown: "Version 1", onChange });

    act(() => {
      root.render(<MarkdownDescriptionEditor markdown="Version 2" onChange={onChange} />);
    });

    expect(mockSetMarkdown).toHaveBeenCalledTimes(1);
    expect(mockSetMarkdown).toHaveBeenCalledWith("Version 2");
    // setMarkdown is muteChange'd — must not reach parent.
    expect(onChange).not.toHaveBeenCalled();

    // Trim-equal external prop after sync must not call setMarkdown again.
    mockSetMarkdown.mockClear();
    act(() => {
      root.render(<MarkdownDescriptionEditor markdown={"Version 2" + "\n"} onChange={onChange} />);
    });
    expect(mockSetMarkdown).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("skips setMarkdown when external markdown matches last synced value", () => {
    const onChange = mock(() => {});
    renderEditor({ markdown: "Stable", onChange });

    act(() => {
      lastEditorProps?.onChange?.("Stable edit", false);
    });
    onChange.mockClear();
    mockSetMarkdown.mockClear();

    act(() => {
      root.render(<MarkdownDescriptionEditor markdown="Stable edit" onChange={onChange} />);
    });

    expect(mockSetMarkdown).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("tracks non-trailing mount normalize so later matching props skip setMarkdown", () => {
    const onChange = mock(() => {});
    mountSecondNormalize = "- item";
    renderEditor({ markdown: "  * item", onChange });

    onChange.mockClear();
    mockSetMarkdown.mockClear();
    act(() => {
      root.render(<MarkdownDescriptionEditor markdown="- item" onChange={onChange} />);
    });

    expect(mockSetMarkdown).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
