/**
 * Markdown-to-React renderer for agent report content.
 *
 * Thin wrapper around `react-markdown` + `remark-gfm` + `rehype-sanitize`.
 * Raw HTML is not interpreted (no `rehype-raw`). Links are restricted to
 * http(s)/relative URLs and forced to open in a new tab with safe `rel`.
 * Remote images are disallowed (agent markdown must not trigger external loads).
 */
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/** Same rule as the previous hand-rolled renderer: http(s) or relative only. */
export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  // Relative URLs (no scheme) are safe and resolve against the dashboard origin.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith("//")) {
    return true;
  }
  return /^https?:/i.test(trimmed);
}

function urlTransform(url: string): string {
  return isSafeUrl(url) ? url.trim() : "";
}

/** Strip media tags so agent markdown cannot trigger remote image loads. */
const DISALLOWED_MEDIA_TAGS = new Set(["img", "picture", "source"]);

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => !DISALLOWED_MEDIA_TAGS.has(tag)),
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https"],
    // No src protocols — even if a media tag slips through, URLs are stripped.
    src: [],
  },
};

const headingSizes: Record<number, string> = {
  1: "mt-6 mb-2 text-base font-semibold tracking-tight text-foreground",
  2: "mt-5 mb-1.5 text-[0.9375rem] font-semibold tracking-tight text-foreground",
  3: "mt-4 mb-1 text-sm font-semibold text-foreground",
  4: "mt-3 mb-1 text-sm font-medium text-foreground",
  5: "mt-3 mb-0.5 text-[0.8125rem] font-medium text-muted-foreground",
  6: "mt-3 mb-0.5 text-xs font-medium text-muted-foreground",
};

const components: Components = {
  h1: ({ children }) => <h1 className={headingSizes[1]}>{children}</h1>,
  h2: ({ children }) => <h2 className={headingSizes[2]}>{children}</h2>,
  h3: ({ children }) => <h3 className={headingSizes[3]}>{children}</h3>,
  h4: ({ children }) => <h4 className={headingSizes[4]}>{children}</h4>,
  h5: ({ children }) => <h5 className={headingSizes[5]}>{children}</h5>,
  h6: ({ children }) => <h6 className={headingSizes[6]}>{children}</h6>,
  p: ({ children }) => <p className="my-2 whitespace-pre-wrap break-words">{children}</p>,
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    // Fenced blocks get `language-*` from remark; inline code does not.
    if (className) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="rounded border border-border bg-raised px-1 py-px font-mono text-[0.85em] break-words text-foreground">
        {children}
      </code>
    );
  },
  ul: ({ children, className }) => (
    <ul
      className={
        className?.includes("contains-task-list")
          ? "my-2 list-none space-y-1 pl-0"
          : "my-2 list-disc space-y-1 pl-5 marker:text-subtle-foreground"
      }
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-subtle-foreground">{children}</ol>
  ),
  li: ({ children, className }) => {
    if (className?.includes("task-list-item")) {
      return <li className="list-none">{children}</li>;
    }
    return <li>{children}</li>;
  },
  input: ({ checked, type }) => {
    if (type !== "checkbox") return null;
    return (
      <span
        className={
          "mr-1.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border align-text-bottom text-[0.65rem] " +
          (checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background")
        }
        aria-hidden
      >
        {checked ? "✓" : ""}
      </span>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => {
    // urlTransform / sanitize strip unsafe schemes to "" — show label only.
    if (!href) {
      return children;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
  },
  // Defense in depth: never render media even if sanitize tags slip through.
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-2 py-1 font-medium text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="max-w-[72ch] text-[0.875rem] leading-[1.6] text-foreground/90 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        urlTransform={urlTransform}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
