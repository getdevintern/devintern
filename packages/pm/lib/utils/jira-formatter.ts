/**
 * JIRA formatting utilities
 * Handles conversion of text content to Atlassian Document Format (ADF)
 */

import {
  type ADFNode,
  markdownToADFContent,
  parseTextWithFormatting,
  textToADFDoc,
} from "@devintern/text-formatter";

export type { ADFNode };

export class JiraFormatter {
  /**
   * Convert plain text or markdown to an ADF document for Jira descriptions.
   *
   * @param text - Source text or markdown content.
   * @returns Root ADF document node.
   */
  static textToADF(text: string): ADFNode {
    // Delegate to the shared ADF implementation.
    return textToADFDoc(text);
  }

  /**
   * Parse text into ADF content block nodes (paragraphs, lists, tables, etc.).
   *
   * @param text - Source text or markdown content.
   * @returns Array of ADF block nodes; never empty (falls back to an empty paragraph).
   */
  static parseTextToADFContent(text: string): ADFNode[] {
    // Keep devpm behavior:
    // - support markdown tables
    // - preserve intra-paragraph newlines
    const content = markdownToADFContent(text, {
      includeTables: true,
      paragraphJoinWith: "\n",
    });
    return content.length > 0
      ? content
      : [{ type: "paragraph", content: [{ type: "text", text: "" }] }];
  }

  /**
   * Parse inline formatting markers (bold, italic, code) into ADF inline nodes.
   *
   * @param text - Single-line or inline text segment.
   * @returns Array of ADF inline/text nodes.
   */
  static parseInlineFormatting(text: string): ADFNode[] {
    // Delegate to the shared ADF implementation.
    return parseTextWithFormatting(text);
  }
}
