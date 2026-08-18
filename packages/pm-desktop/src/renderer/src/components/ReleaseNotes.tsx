import React from "react";

const DROPPED_TAGS = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "img",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "picture",
  "plaintext",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "track",
  "video",
  "xmp",
]);

const TAG_CLASSES: Record<string, string | undefined> = {
  article: "space-y-1.5",
  blockquote: "my-2 border-l-2 border-border pl-3 italic text-muted-foreground",
  code: "rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]",
  del: "text-muted-foreground line-through",
  div: "space-y-1.5",
  em: "italic",
  h1: "mt-2 text-base font-semibold text-foreground",
  h2: "mt-2 text-sm font-semibold text-foreground",
  h3: "mt-2 text-sm font-medium text-foreground",
  h4: "mt-1.5 text-xs font-medium text-foreground",
  h5: "mt-1.5 text-xs font-medium text-foreground",
  h6: "mt-1.5 text-xs font-medium text-foreground",
  li: "pl-0.5",
  ol: "my-1.5 list-decimal space-y-0.5 pl-5",
  p: "my-1.5",
  pre: "my-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs",
  section: "space-y-1.5",
  strong: "font-semibold text-foreground",
  table: "my-2 w-full border-collapse text-left text-xs",
  td: "border border-border px-2 py-1 align-top",
  th: "border border-border bg-muted px-2 py-1 font-medium",
  ul: "my-1.5 list-disc space-y-0.5 pl-5",
};

const ALLOWED_TAGS = new Set([
  ...Object.keys(TAG_CLASSES),
  "a",
  "b",
  "br",
  "hr",
  "i",
  "s",
  "span",
  "tbody",
  "thead",
  "tr",
  "u",
]);

const MAX_RELEASE_NOTES_HTML_LENGTH = 20_000;
const MAX_RELEASE_NOTES_DEPTH = 24;
const MAX_RELEASE_NOTES_NODES = 1_000;

/** Release-note links are external, so only absolute HTTP(S) URLs are usable. */
export function isSafeReleaseNotesUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

interface RenderResult {
  meaningful: boolean;
  nodes: React.ReactNode[];
}

interface RenderBudget {
  exceeded: boolean;
  remainingNodes: number;
}

function renderNodes(
  nodes: NodeListOf<ChildNode>,
  keyPrefix: string,
  depth: number,
  budget: RenderBudget,
): RenderResult {
  const output: React.ReactNode[] = [];
  let meaningful = false;

  if (depth > MAX_RELEASE_NOTES_DEPTH) {
    budget.exceeded = true;
    return { meaningful, nodes: output };
  }

  for (let index = 0; index < nodes.length; index++) {
    if (budget.remainingNodes === 0) {
      budget.exceeded = true;
      break;
    }
    budget.remainingNodes--;

    const node = nodes[index];
    if (!node) continue;
    const key = `${keyPrefix}-${index}`;
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      output.push(text);
      meaningful ||= text.trim().length > 0;
      continue;
    }
    if (node.nodeType !== 1) continue;

    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (DROPPED_TAGS.has(tag)) continue;

    const children = renderNodes(element.childNodes, key, depth + 1, budget);
    if (budget.exceeded) break;
    if (!ALLOWED_TAGS.has(tag)) {
      output.push(...children.nodes);
      meaningful ||= children.meaningful;
      continue;
    }

    if (tag === "br") {
      output.push(React.createElement("br", { key }));
      continue;
    }
    if (tag === "hr") {
      output.push(React.createElement("hr", { className: "my-2 border-border", key }));
      meaningful = true;
      continue;
    }
    if (tag === "a") {
      const href = element.getAttribute("href")?.trim() ?? "";
      if (!isSafeReleaseNotesUrl(href)) {
        output.push(...children.nodes);
        meaningful ||= children.meaningful;
        continue;
      }
      const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        void window.pm.openExternal(href);
      };
      output.push(
        React.createElement(
          "button",
          {
            className:
              "cursor-pointer border-0 bg-transparent p-0 text-primary underline underline-offset-2 hover:text-primary/80",
            key,
            onClick,
            title: element.getAttribute("title") ?? undefined,
            type: "button",
          },
          children.nodes,
        ),
      );
      meaningful ||= children.meaningful;
      continue;
    }

    const normalizedTag = tag === "b" ? "strong" : tag === "i" ? "em" : tag;
    output.push(
      React.createElement(
        normalizedTag,
        { className: TAG_CLASSES[normalizedTag], key },
        children.nodes,
      ),
    );
    meaningful ||= children.meaningful;
  }

  return { meaningful, nodes: output };
}

function renderReleaseNotes(html: string | null | undefined): RenderResult {
  if (!html?.trim()) return { meaningful: false, nodes: [] };
  if (html.length > MAX_RELEASE_NOTES_HTML_LENGTH) return { meaningful: false, nodes: [] };

  try {
    // A template parses malformed HTML using the browser's normal recovery
    // rules, but its contents stay inert and are never mounted as raw HTML.
    const template = document.createElement("template");
    template.innerHTML = html;
    const budget: RenderBudget = {
      exceeded: false,
      remainingNodes: MAX_RELEASE_NOTES_NODES,
    };
    const rendered = renderNodes(template.content.childNodes, "release-note", 0, budget);
    return budget.exceeded ? { meaningful: false, nodes: [] } : rendered;
  } catch {
    return { meaningful: false, nodes: [] };
  }
}

export function ReleaseNotes({ html }: { html: string | null | undefined }) {
  const rendered = renderReleaseNotes(html);

  return (
    <div
      className="max-h-48 min-w-0 max-w-full overflow-y-auto overscroll-contain break-words pr-1 text-xs leading-relaxed [overflow-wrap:anywhere]"
      data-testid="update-notifier-notes"
    >
      {rendered.meaningful ? (
        rendered.nodes
      ) : (
        <p className="text-muted-foreground">Release notes are unavailable.</p>
      )}
    </div>
  );
}
