/** Markdown-to-HTML rendering for the Azure DevOps fake's stored descriptions and comments. */

/** Escape HTML characters so seeded markdown text cannot inject markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a small markdown subset (headings, blank-line paragraphs, line
 * breaks) as the HTML Azure DevOps stores in `System.Description` and comments.
 */
export function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map(escapeHtml).join("<br>")}</p>`);
    paragraph = [];
  };

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading?.[1] && heading[2] !== undefined) {
      flushParagraph();
      const level = heading[1].length;
      blocks.push(`<h${level}>${escapeHtml(heading[2].trim())}</h${level}>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks.join("\n") || "<p> </p>";
}
