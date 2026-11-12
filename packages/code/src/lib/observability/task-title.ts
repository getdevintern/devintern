/**
 * Short plain-text title for a task description. A leading `---` frontmatter
 * block (local/markdown tasks) is skipped: its `title:` field wins, otherwise
 * the first heading or line of the body is used.
 */
export function deriveTaskTitle(description: string | undefined): string | undefined {
  if (!description) return undefined;
  let body = description;
  let frontmatterTitle: string | undefined;
  const fenced = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (fenced) {
    const match = /^title:[ \t]*(.+)$/m.exec(fenced[1]!);
    frontmatterTitle = match?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    body = body.slice(fenced[0].length);
  }
  const clean = (text: string | undefined): string | undefined =>
    text
      ?.trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/[*_`]/g, "")
      .slice(0, 160) || undefined;
  return (
    clean(frontmatterTitle) ??
    clean(
      body
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean),
    )
  );
}
