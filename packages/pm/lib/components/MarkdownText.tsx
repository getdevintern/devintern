import React from "react";
import { Text, Box } from "ink";

interface MarkdownTextProps {
  children: string;
}

/**
 * Simple markdown renderer for Ink terminal output.
 *
 * Supports headers, bullet/numbered lists, fenced code blocks, and inline formatting.
 *
 * @param children - Raw markdown string to render.
 * @returns Vertical stack of formatted Ink Text and Box elements.
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({ children }) => {
  const lines = children.split("\n");
  const elements: React.ReactNode[] = [];

  let inCodeBlock = false;
  let codeBlockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Code blocks
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        // End code block
        elements.push(
          <Box key={`code-${i}`} flexDirection="column" paddingLeft={2}>
            {codeBlockLines.map((codeLine, idx) => (
              <Text key={idx} color="gray">
                {codeLine}
              </Text>
            ))}
          </Box>,
        );
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        // Start code block
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Headers
    if (line.startsWith("### ")) {
      elements.push(
        <Text key={i} bold color="cyan">
          {line.substring(4)}
        </Text>,
      );
      continue;
    }

    if (line.startsWith("## ")) {
      elements.push(
        <Text key={i} bold color="cyan">
          {line.substring(3)}
        </Text>,
      );
      continue;
    }

    if (line.startsWith("# ")) {
      elements.push(
        <Text key={i} bold color="cyan">
          {line.substring(2)}
        </Text>,
      );
      continue;
    }

    // Bullet lists
    if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
      const indent = line.search(/[*-]/);
      const content = line.substring(indent + 2);
      elements.push(
        <Box key={i} paddingLeft={Math.floor(indent / 2)}>
          <Text>• {renderInlineMarkdown(content)}</Text>
        </Box>,
      );
      continue;
    }

    // Numbered lists
    const numberedMatch = line.match(/^(\s*)(\d+)\.\s(.+)$/);
    if (numberedMatch) {
      const indent = numberedMatch[1]?.length ?? 0;
      const number = numberedMatch[2];
      const content = numberedMatch[3] ?? "";
      elements.push(
        <Box key={i} paddingLeft={Math.floor(indent / 2)}>
          <Text>
            {number}. {renderInlineMarkdown(content)}
          </Text>
        </Box>,
      );
      continue;
    }

    // Empty lines
    if (line.trim() === "") {
      elements.push(<Text key={i}> </Text>);
      continue;
    }

    // Regular text with inline formatting
    elements.push(<Text key={i}>{renderInlineMarkdown(line)}</Text>);
  }

  return <Box flexDirection="column">{elements}</Box>;
};

/**
 * Parses and renders inline markdown (bold, italic, and inline code).
 *
 * @param text - Single line of text that may contain inline markdown tokens.
 * @returns React fragment with styled Ink Text segments.
 */
function renderInlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold (**text** or __text__)
    const boldMatch = remaining.match(/^(.*?)(\*\*|__)(.+?)\2/);
    if (boldMatch && boldMatch[1] !== undefined && boldMatch[3] !== undefined) {
      if (boldMatch[1]) {
        parts.push(<React.Fragment key={key++}>{boldMatch[1]}</React.Fragment>);
      }
      parts.push(
        <Text key={key++} bold>
          {boldMatch[3]}
        </Text>,
      );
      remaining = remaining.substring(
        (boldMatch[1]?.length ?? 0) + (boldMatch[2]?.length ?? 0) * 2 + (boldMatch[3]?.length ?? 0),
      );
      continue;
    }

    // Italic (*text* or _text_)
    const italicMatch = remaining.match(/^(.*?)([*_])(.+?)\2/);
    if (italicMatch && italicMatch[1] !== undefined && italicMatch[3] !== undefined) {
      if (italicMatch[1]) {
        parts.push(<React.Fragment key={key++}>{italicMatch[1]}</React.Fragment>);
      }
      parts.push(
        <Text key={key++} italic>
          {italicMatch[3]}
        </Text>,
      );
      remaining = remaining.substring(
        (italicMatch[1]?.length ?? 0) +
          (italicMatch[2]?.length ?? 0) * 2 +
          (italicMatch[3]?.length ?? 0),
      );
      continue;
    }

    // Inline code (`code`)
    const codeMatch = remaining.match(/^(.*?)`(.+?)`/);
    if (codeMatch && codeMatch[1] !== undefined && codeMatch[2] !== undefined) {
      if (codeMatch[1]) {
        parts.push(<React.Fragment key={key++}>{codeMatch[1]}</React.Fragment>);
      }
      parts.push(
        <Text key={key++} color="gray">
          {codeMatch[2]}
        </Text>,
      );
      remaining = remaining.substring(
        (codeMatch[1]?.length ?? 0) + 2 + (codeMatch[2]?.length ?? 0),
      );
      continue;
    }

    // No more special formatting, just add the rest
    parts.push(<React.Fragment key={key++}>{remaining}</React.Fragment>);
    break;
  }

  return <>{parts}</>;
}
