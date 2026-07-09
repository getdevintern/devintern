import { textToADFDoc, type ADFDoc } from "@devintern/text-formatter";

/**
 * Convert plain text or markdown to an ADF document for Jira descriptions.
 *
 * @param text - Source text or markdown content.
 * @returns Root ADF document node.
 */
export function textToADF(text: string): ADFDoc {
  return textToADFDoc(text);
}
