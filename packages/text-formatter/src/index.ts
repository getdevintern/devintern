/**
 * Shared Atlassian Document Format (ADF) utilities.
 *
 * This package is intentionally "dumb" and dependency-free: it only handles
 * parsing/sanitizing/ADF node construction and is safe to reuse across CLIs.
 *
 * Scope:
 * - Text sanitization for Jira (strip ANSI codes, normalize newlines, truncate)
 * - Markdown-ish parsing into ADF nodes (headings, lists, code blocks, tables)
 * - Inline formatting marks (bold/italic/inline code)
 *
 * Non-goals:
 * - Full CommonMark compliance
 * - Deep validation against Jira's ADF schema
 */

export interface ADFMark {
  type: string;
}

export interface ADFNode {
  type: string;
  version?: number;
  // ADF attributes vary by node type and are not fully modeled here.
  attrs?: Record<string, unknown>;
  content?: ADFNode[];
  text?: string;
  marks?: ADFMark[];
}

export interface ADFDoc extends ADFNode {
  type: "doc";
  version: 1;
  content: ADFNode[];
}

export interface MarkdownToAdfOptions {
  includeTables?: boolean;
  paragraphJoinWith?: string;
}

export interface ExtractTextFromADFOptions {
  /**
   * Separator used when joining arrays of nodes.
   * - "" preserves tightly concatenated text
   * - " " mirrors simpler flattening behavior
   */
  arrayJoinWith?: string;
  /**
   * Add "\n" after top-level paragraph nodes, except the final node.
   */
  topLevelParagraphNewline?: boolean;
  /**
   * Add "\n" after top-level heading nodes.
   */
  topLevelHeadingNewline?: boolean;
}

/**
 * Clean and normalize text before posting to Jira.
 *
 * Typical usage:
 * - Remove ANSI escape sequences (common in CLI output).
 * - Normalize line endings (CRLF/CR -> LF).
 * - Optionally collapse excessive newlines.
 * - Enforce a practical max length (Jira comments/descriptions have limits).
 * - Provide a fallback message when output is empty/too short.
 */
export function sanitizeJiraOutput(
  output: string,
  options?: {
    maxLength?: number;
    minLength?: number;
    fallbackMessage?: string;
    collapseExcessNewlines?: boolean;
  },
): string {
  // Remove ANSI escape codes and control characters.
  //
  // We avoid a regex literal here to keep escapes readable across toolchains.
  // Example sequence: "\x1b[32m" (green) ... "\x1b[0m" (reset)
  // NOTE: Biome flags `\x1b` in regex literals as a control character.
  // Using the unicode escape keeps the intent clear and passes the linter.
  // Biome flags the escape in a regex literal here, so we intentionally use RegExp.
  // biome-ignore lint/complexity/useRegexLiterals: see comment above
  let cleaned = output.replace(new RegExp("\\u001b\\[[0-9;]*m", "g"), "");

  // Normalize line breaks.
  cleaned = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove excessive whitespace/newlines.
  if (options?.collapseExcessNewlines ?? true) {
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  }

  // Trim and limit length (Jira has practical limits).
  cleaned = cleaned.trim();

  // If output is too long, truncate and add note.
  const maxLength = options?.maxLength ?? 8000;
  if (cleaned.length > maxLength) {
    cleaned = `${cleaned.substring(0, maxLength)}\n\n[Output truncated due to length]`;
  }

  // If output is very short or empty, provide a generic message.
  const minLength = options?.minLength ?? 0;
  if (cleaned.length < minLength) {
    return (
      options?.fallbackMessage ??
      "@devintern completed the implementation successfully. Please check the committed changes for details."
    );
  }

  return cleaned;
}

/**
 * Parse inline formatting and return a list of ADF "text" nodes.
 *
 * Supported marks:
 * - Inline code: `code`
 * - Bold: **text**
 * - Italic: *text*
 *
 * Notes:
 * - This is intentionally a minimal parser designed for AI-generated markdown-ish output.
 * - Unclosed markers are treated as plain text (do not throw).
 */
export function parseTextWithFormatting(text: string): ADFNode[] {
  const content: ADFNode[] = [];
  let currentText = "";
  let i = 0;

  const flushText = () => {
    if (currentText) {
      content.push({
        type: "text",
        text: currentText,
      });
      currentText = "";
    }
  };

  while (i < text.length) {
    if (text[i] === "`" && text[i + 1] !== "`") {
      flushText();
      const codeStart = i + 1;
      let codeEnd = text.indexOf("`", codeStart);
      if (codeEnd === -1) codeEnd = text.length;

      content.push({
        type: "text",
        text: text.substring(codeStart, codeEnd),
        marks: [{ type: "code" }],
      });

      i = codeEnd + 1;
      continue;
    }

    if (text.substring(i, i + 2) === "**") {
      flushText();
      const boldStart = i + 2;
      const boldEnd = text.indexOf("**", boldStart);
      if (boldEnd !== -1) {
        content.push({
          type: "text",
          text: text.substring(boldStart, boldEnd),
          marks: [{ type: "strong" }],
        });
        i = boldEnd + 2;
        continue;
      }
    }

    if (text[i] === "*" && text[i + 1] !== "*") {
      flushText();
      const italicStart = i + 1;
      const italicEnd = text.indexOf("*", italicStart);
      if (italicEnd !== -1) {
        content.push({
          type: "text",
          text: text.substring(italicStart, italicEnd),
          marks: [{ type: "em" }],
        });
        i = italicEnd + 1;
        continue;
      }
    }

    currentText += text[i] ?? "";
    i++;
  }

  flushText();
  return content.length > 0 ? content : [{ type: "text", text }];
}

/**
 * Parses pipe-separated markdown table rows into an ADF `table` node.
 *
 * Expects the first row as headers and subsequent rows as data. Separator rows
 * (e.g. `|---|---|`) should be stripped by the caller before calling.
 *
 * @param tableLines - Non-empty table rows without markdown separator lines.
 * @returns ADF table node, or `null` when `tableLines` is empty.
 */
export function parseMarkdownTable(tableLines: string[]): ADFNode | null {
  if (tableLines.length === 0) return null;

  // Parse cells from a table row.
  const parseCells = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  };

  const headerCells = parseCells(tableLines[0] ?? "");
  const numColumns = headerCells.length;

  const headerRow: ADFNode = {
    type: "tableRow",
    content: headerCells.map(
      (cellText) =>
        ({
          type: "tableHeader",
          attrs: {},
          content: [
            {
              type: "paragraph",
              content: parseTextWithFormatting(cellText),
            },
          ],
        }) as ADFNode,
    ),
  };

  const dataRows = tableLines.slice(1).map((line) => {
    const cells = parseCells(line);
    while (cells.length < numColumns) {
      cells.push("");
    }

    return {
      type: "tableRow",
      content: cells.slice(0, numColumns).map(
        (cellText) =>
          ({
            type: "tableCell",
            attrs: {},
            content: [
              {
                type: "paragraph",
                content: parseTextWithFormatting(cellText),
              },
            ],
          }) as ADFNode,
      ),
    } as ADFNode;
  });

  return {
    type: "table",
    attrs: {
      isNumberColumnEnabled: false,
      layout: "default",
    },
    content: [headerRow, ...dataRows],
  };
}

/**
 * Convert markdown-ish text into Jira ADF content nodes.
 *
 * Supported blocks:
 * - Code blocks: ```lang ... ```
 * - Headings: # / ## / ### (up to 6)
 * - Bullet lists: -, *, +
 * - Ordered lists: 1. 2. 3.
 * - Tables: pipes-separated rows (optional)
 *
 * Notes:
 * - This does not attempt full markdown parsing; it targets the formats we generate most.
 * - `paragraphJoinWith` controls how multi-line paragraphs are joined before inline parsing:
 *   - " " (space): good for Jira comments (dense summary)
 *   - "\n": good for Jira descriptions (preserve line breaks)
 */
export function markdownToADFContent(text: string, options?: MarkdownToAdfOptions): ADFNode[] {
  const includeTables = options?.includeTables ?? true;
  const paragraphJoinWith = options?.paragraphJoinWith ?? " ";

  const content: ADFNode[] = [];
  const lines = text.split("\n");
  let currentParagraph: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLanguage = "";

  const flushParagraph = () => {
    if (currentParagraph.length === 0) return;
    const paragraphText = currentParagraph.join(paragraphJoinWith).trim();
    if (paragraphText) {
      content.push({
        type: "paragraph",
        content: parseTextWithFormatting(paragraphText),
      });
    }
    currentParagraph = [];
  };

  const flushCodeBlock = () => {
    if (codeBlockContent.length === 0) return;
    content.push({
      type: "codeBlock",
      attrs: { language: codeBlockLanguage || "text" },
      content: [
        {
          type: "text",
          text: codeBlockContent.join("\n"),
        },
      ],
    });
    codeBlockContent = [];
    codeBlockLanguage = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith("```")) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        flushParagraph();
        inCodeBlock = true;
        codeBlockLanguage = trimmedLine.substring(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    if (trimmedLine.startsWith("#")) {
      flushParagraph();
      const level = Math.min(6, (trimmedLine.match(/^#+/) || [""])[0].length);
      const headerText = trimmedLine.replace(/^#+\s*/, "");
      content.push({
        type: "heading",
        attrs: { level },
        content: [{ type: "text", text: headerText }],
      });
      continue;
    }

    if (trimmedLine.match(/^[-*+]\s/)) {
      flushParagraph();
      const listItems: ADFNode[] = [];
      let j = i;

      while (j < lines.length && (lines[j] ?? "").trim().match(/^[-*+]\s/)) {
        const itemText = (lines[j] ?? "").trim().replace(/^[-*+]\s/, "");
        listItems.push({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: parseTextWithFormatting(itemText),
            },
          ],
        });
        j++;
      }

      content.push({
        type: "bulletList",
        content: listItems,
      });

      i = j - 1;
      continue;
    }

    if (trimmedLine.match(/^\d+\.\s/)) {
      flushParagraph();
      const listItems: ADFNode[] = [];
      let j = i;

      while (j < lines.length && (lines[j] ?? "").trim().match(/^\d+\.\s/)) {
        const itemText = (lines[j] ?? "").trim().replace(/^\d+\.\s/, "");
        listItems.push({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: parseTextWithFormatting(itemText),
            },
          ],
        });
        j++;
      }

      content.push({
        type: "orderedList",
        content: listItems,
      });

      i = j - 1;
      continue;
    }

    if (includeTables && trimmedLine.includes("|")) {
      flushParagraph();
      const tableLines: string[] = [];
      let j = i;

      while (j < lines.length && (lines[j] ?? "").trim().includes("|")) {
        const tableLine = (lines[j] ?? "").trim();
        if (!tableLine.match(/^\|[\s\-:|]+\|$/)) {
          tableLines.push(tableLine);
        }
        j++;
      }

      if (tableLines.length > 0) {
        const table = parseMarkdownTable(tableLines);
        if (table) {
          content.push(table);
        }
      }

      i = j - 1;
      continue;
    }

    if (trimmedLine === "") {
      flushParagraph();
      continue;
    }

    currentParagraph.push(line);
  }

  flushParagraph();
  flushCodeBlock();

  return content;
}

/**
 * Wraps markdown-parsed content in a top-level ADF `doc` suitable for Jira API v3.
 *
 * @param text - Markdown-ish source text.
 * @param options - Passed through to {@link markdownToADFContent}.
 * @returns Complete ADF document with `version: 1` and at least one paragraph when input is empty.
 */
export function textToADFDoc(text: string, options?: MarkdownToAdfOptions): ADFDoc {
  // Wrap parsed nodes in an ADF `doc` container, as required by Jira API v3.
  const content = markdownToADFContent(text, options);
  return {
    type: "doc",
    version: 1,
    content:
      content.length > 0 ? content : [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
  };
}

/**
 * Extract plain text from Atlassian Document Format structures.
 *
 * This supports:
 * - raw strings
 * - ADF-like objects with `type`, `text`, and nested `content`
 * - plain arrays of nodes
 *
 * Behavior is configurable so callers can preserve their current output:
 * - `@devintern/code`: top-level paragraph/heading newlines
 * - `@devintern/pm`: flattened text joined with spaces
 */
export function extractTextFromADF(input: unknown, options?: ExtractTextFromADFOptions): string {
  if (input == null) return "";
  if (typeof input === "string") return input;

  const arrayJoinWith = options?.arrayJoinWith ?? "";
  const topLevelParagraphNewline = options?.topLevelParagraphNewline ?? false;
  const topLevelHeadingNewline = options?.topLevelHeadingNewline ?? false;

  const walk = (node: unknown, isTopLevel = false, index = 0, total = 0): string => {
    if (node == null) return "";
    if (typeof node === "string") return node;

    if (Array.isArray(node)) {
      return node
        .map((child, childIndex) => walk(child, isTopLevel, childIndex, node.length))
        .join(arrayJoinWith);
    }

    if (typeof node !== "object") return "";
    const candidate = node as {
      type?: string;
      text?: unknown;
      content?: unknown;
    };

    if (candidate.type === "text") {
      return typeof candidate.text === "string" ? candidate.text : "";
    }

    if (candidate.type === "paragraph") {
      const text = walk(candidate.content ?? [], false);
      if (isTopLevel && topLevelParagraphNewline && index < total - 1) {
        return `${text}\n`;
      }
      return text;
    }

    if (candidate.type === "heading") {
      const text = walk(candidate.content ?? [], false);
      if (isTopLevel && topLevelHeadingNewline) {
        return `${text}\n`;
      }
      return text;
    }

    if ("content" in candidate) {
      return walk(candidate.content ?? [], false);
    }

    return "";
  };

  // If this is a doc-like object, traverse top-level content with top-level semantics.
  if (typeof input === "object" && input !== null && "content" in input) {
    const top = (input as { content?: unknown }).content;
    if (Array.isArray(top)) {
      return top.map((node, index) => walk(node, true, index, top.length)).join(arrayJoinWith);
    }
    return walk(top, true, 0, 1);
  }

  return walk(input, true, 0, 1);
}

/**
 * Escapes HTML special characters after stripping invalid XML characters.
 *
 * @param text - Raw text that may contain `&`, `<`, `>`, or `"`.
 * @returns XML-safe escaped string.
 */
function escapeHtml(text: string): string {
  return sanitizeXmlChars(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Strip characters that are invalid in XML 1.0 document content.
 *
 * @param text - Input string that may contain control characters.
 * @returns Sanitized text safe for XML/HTML fragments.
 */
function sanitizeXmlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}

type AsanaHtmlBlock = {
  kind: "inline" | "block";
  html: string;
};

/**
 * Concatenates formatted HTML blocks with appropriate separators.
 *
 * @param blocks - Ordered inline or block HTML fragments.
 * @param options - When `wrapInlineInDiv` is true, wraps inline blocks in `<div>` (Azure DevOps).
 * @returns Combined HTML string.
 */
function joinHtmlBlocks(blocks: AsanaHtmlBlock[], options?: { wrapInlineInDiv?: boolean }): string {
  let result = "";
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const prev = blocks[i - 1];
    const blockHtml =
      block.kind === "inline" && options?.wrapInlineInDiv ? `<div>${block.html}</div>` : block.html;
    if (i > 0) {
      if (!options?.wrapInlineInDiv && prev?.kind === "inline" && block.kind === "inline") {
        result += "\n\n";
      } else {
        result += "\n";
      }
    }
    result += blockHtml;
  }
  return result;
}

/**
 * Converts markdown-ish text into Asana/Azure-compatible HTML blocks before joining.
 *
 * Supports code fences, headings, bullet/ordered lists, horizontal rules, and pipe tables.
 *
 * @param text - Markdown-ish source text.
 * @returns Inline and block HTML segments for {@link joinHtmlBlocks}.
 */
function buildMarkdownHtmlBlocks(text: string): AsanaHtmlBlock[] {
  const blocks: AsanaHtmlBlock[] = [];
  const lines = sanitizeXmlChars(text).split("\n");
  let currentParagraph: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length === 0) return;
    const paragraphText = currentParagraph.join("\n").trim();
    if (paragraphText) {
      blocks.push({
        kind: "inline",
        html: formatInlineMarkdownToHtml(paragraphText),
      });
    }
    currentParagraph = [];
  };

  const flushCodeBlock = () => {
    if (codeBlockContent.length === 0) return;
    blocks.push({
      kind: "block",
      html: `<pre>${escapeHtml(codeBlockContent.join("\n"))}</pre>`,
    });
    codeBlockContent = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith("```")) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        flushParagraph();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    if (trimmedLine.startsWith("#")) {
      flushParagraph();
      const level = Math.min(6, (trimmedLine.match(/^#+/) || [""])[0].length);
      const headerText = trimmedLine.replace(/^#+\s*/, "").trim();
      if (headerText) {
        const tag = level <= 1 ? "h1" : "h2";
        blocks.push({
          kind: "block",
          html: `<${tag}>${formatInlineMarkdownToHtml(headerText)}</${tag}>`,
        });
      }
      continue;
    }

    if (trimmedLine.match(/^[-*+]\s/) || trimmedLine.match(/^[-*+]\s\[[ xX]\]\s/)) {
      flushParagraph();
      const listItems: string[] = [];
      let j = i;

      while (j < lines.length) {
        const itemLine = (lines[j] ?? "").trim();
        const bulletMatch = itemLine.match(/^[-*+]\s(?:\[[ xX]\]\s)?(.*)$/);
        if (!bulletMatch) break;
        const itemHtml = formatInlineMarkdownToHtml((bulletMatch[1] ?? "").trim());
        if (itemHtml) {
          listItems.push(`<li>${itemHtml}</li>`);
        }
        j++;
      }

      if (listItems.length > 0) {
        blocks.push({
          kind: "block",
          html: `<ul>${listItems.join("")}</ul>`,
        });
      }
      i = j - 1;
      continue;
    }

    if (trimmedLine.match(/^\d+\.\s/)) {
      flushParagraph();
      const listItems: string[] = [];
      let j = i;

      while (j < lines.length && (lines[j] ?? "").trim().match(/^\d+\.\s/)) {
        const itemText = (lines[j] ?? "").trim().replace(/^\d+\.\s/, "");
        const itemHtml = formatInlineMarkdownToHtml(itemText);
        if (itemHtml) {
          listItems.push(`<li>${itemHtml}</li>`);
        }
        j++;
      }

      if (listItems.length > 0) {
        blocks.push({
          kind: "block",
          html: `<ol>${listItems.join("")}</ol>`,
        });
      }
      i = j - 1;
      continue;
    }

    if (trimmedLine.match(/^[-*_]{3,}$/)) {
      flushParagraph();
      blocks.push({ kind: "block", html: "<hr></hr>" });
      continue;
    }

    if (trimmedLine.includes("|")) {
      flushParagraph();
      const tableLines: string[] = [];
      let j = i;

      while (j < lines.length && (lines[j] ?? "").trim().includes("|")) {
        const tableLine = (lines[j] ?? "").trim();
        if (!tableLine.match(/^\|[\s\-:|]+\|$/)) {
          tableLines.push(tableLine);
        }
        j++;
      }

      if (tableLines.length > 0) {
        blocks.push({
          kind: "block",
          html: `<pre>${escapeHtml(tableLines.join("\n"))}</pre>`,
        });
      }

      i = j - 1;
      continue;
    }

    if (trimmedLine === "") {
      flushParagraph();
      continue;
    }

    currentParagraph.push(line);
  }

  flushParagraph();
  flushCodeBlock();

  return blocks;
}

/**
 * Parse inline markdown into Asana-compatible HTML (strong, em, code).
 * Targets the same markdown-ish output we generate for Jira descriptions.
 */
export function formatInlineMarkdownToHtml(text: string): string {
  let result = "";
  let currentText = "";
  let i = 0;

  const flushText = () => {
    if (currentText) {
      result += escapeHtml(currentText);
      currentText = "";
    }
  };

  while (i < text.length) {
    if (text[i] === "`" && text[i + 1] !== "`") {
      flushText();
      const codeStart = i + 1;
      let codeEnd = text.indexOf("`", codeStart);
      if (codeEnd === -1) codeEnd = text.length;
      result += `<code>${escapeHtml(text.substring(codeStart, codeEnd))}</code>`;
      i = codeEnd + 1;
      continue;
    }

    if (text.substring(i, i + 2) === "**") {
      flushText();
      const boldStart = i + 2;
      const boldEnd = text.indexOf("**", boldStart);
      if (boldEnd !== -1) {
        result += `<strong>${escapeHtml(text.substring(boldStart, boldEnd))}</strong>`;
        i = boldEnd + 2;
        continue;
      }
    }

    if (text[i] === "*" && text[i + 1] !== "*") {
      flushText();
      const italicStart = i + 1;
      const italicEnd = text.indexOf("*", italicStart);
      if (italicEnd !== -1) {
        result += `<em>${escapeHtml(text.substring(italicStart, italicEnd))}</em>`;
        i = italicEnd + 1;
        continue;
      }
    }

    currentText += text[i] ?? "";
    i++;
  }

  flushText();
  return result;
}

/**
 * Convert markdown-ish text into HTML for multiline HTML fields (e.g. Azure DevOps Description).
 *
 * Azure DevOps `System.Description` defaults to HTML — markdown is not rendered unless you also
 * set `/multilineFieldsFormat/System.Description` to `Markdown` via the REST API.
 * @see https://devblogs.microsoft.com/devops/markdown-support-arrives-for-work-items/
 */
export function markdownToHtmlDescription(text: string): string {
  const blocks = buildMarkdownHtmlBlocks(text);
  return blocks.length > 0
    ? joinHtmlBlocks(blocks, { wrapInlineInDiv: true })
    : escapeHtml(text.trim()) || " ";
}

/**
 * Convert markdown-ish text into Asana `html_notes` (XML fragment wrapped in `<body>`).
 *
 * Asana does not render markdown in `notes` — use `html_notes` with a restricted HTML subset.
 * @see https://developers.asana.com/docs/rich-text
 */
export function markdownToAsanaHtmlNotes(text: string): string {
  const blocks = buildMarkdownHtmlBlocks(text);
  const inner = blocks.length > 0 ? joinHtmlBlocks(blocks) : escapeHtml(text.trim()) || " ";
  return `<body>${inner}</body>`;
}
