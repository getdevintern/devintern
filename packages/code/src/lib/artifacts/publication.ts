import { redactAgentOutput } from "../agent/harness-startup";
import { stripAnsi } from "../observability/worker-logs";
import type { ArtifactPolicy, ArtifactRegistry, ArtifactSelection, RunArtifact } from "./types";

export const ARTIFACT_COMMENT_MARKER = "<!-- devintern:artifacts:v1 -->";
const MAX_COMMENT_CHARS = 45_000;

/** Fail invalid publication settings before starting the coding agent. */
export function validateArtifactPolicy(policy: ArtifactPolicy | undefined): void {
  if (policy === undefined) return;
  if (!policy || typeof policy !== "object" || Array.isArray(policy))
    throw new Error("pipeline.artifacts must be an object");
  if (policy.publish === undefined) return;
  const publish = policy.publish;
  if (
    !publish ||
    publish.destination !== "pr-comment" ||
    !Array.isArray(publish.select) ||
    publish.select.length === 0 ||
    publish.select.length > 100
  )
    throw new Error(
      "pipeline.artifacts.publish requires destination 'pr-comment' and 1–100 selections",
    );
  if (
    publish.uploader !== undefined &&
    (typeof publish.uploader !== "string" || !publish.uploader.trim())
  )
    throw new Error("Artifact uploader must be a module path or package name");
  const keys = new Set<string>();
  for (const selection of publish.select) {
    if (
      !selection ||
      typeof selection.key !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(selection.key) ||
      !["inline", "collapsed", "embed", "link"].includes(selection.presentation) ||
      (selection.optional !== undefined && typeof selection.optional !== "boolean")
    )
      throw new Error("Invalid artifact publication selection");
    if (keys.has(selection.key))
      throw new Error(`Duplicate artifact publication key: ${selection.key}`);
    keys.add(selection.key);
  }
}

/** References are explicit artifact:key URLs; the same Markdown works locally and after upload. */
export function resolveArtifactReferences(
  markdown: string,
  resolveUrl: (key: string) => string | undefined,
): string {
  return markdown.replace(
    /(!?)\[([^\]]*)\]\(artifact:([a-zA-Z0-9._-]+)\)/g,
    (_match, image: string, label: string, key: string) => {
      const url = resolveUrl(key);
      return url ? `${image}[${label}](${url})` : `${label || key} (artifact unavailable)`;
    },
  );
}

/**
 * Upload errors come from adapters (custom modules, S3 presigned URLs, code-host
 * APIs) and may echo credentials. Mask known token shapes (including GitHub
 * fine-grained `github_pat_` and GitLab `glpat-` PATs), strip URL userinfo, and
 * drop URL query strings/fragments (presigned signatures) before the text
 * leaves the machine.
 */
export function redactUploadError(message: string): string {
  return redactAgentOutput(stripAnsi(message))
    .replace(/\b(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?[redacted]");
}

/** One-line, Markdown-inert, redacted status text for reviewer-facing comments. */
function sanitizeStatus(message: string): string {
  const line = redactUploadError(message).replace(/\s+/g, " ").trim().slice(0, 300);
  return line.replace(/[\\`*_[\]<>!|#]/g, (char) => `\\${char}`);
}

/** Latest execution wins for each logical key; previous attempts remain in the dashboard. */
export function selectPublishedArtifacts(
  registry: ArtifactRegistry,
  selections: ArtifactSelection[],
): RunArtifact[] {
  const latest = new Map(registry.list().map((artifact) => [artifact.key, artifact]));
  return selections.flatMap(({ key }) => (latest.get(key) ? [latest.get(key)!] : []));
}

/** Bounded reviewer summary. Upload URLs are supplied by an adapter, never inferred from local paths. */
export function buildArtifactComment(
  registry: ArtifactRegistry,
  policy: ArtifactPolicy | undefined,
  urls: ReadonlyMap<string, string> = new Map(),
  failures: ReadonlyMap<string, string> = new Map(),
): { body: string; ids: string[] } | undefined {
  if (!policy?.publish) return undefined;
  const artifacts = selectPublishedArtifacts(registry, policy.publish.select);
  const last = artifacts.at(-1);
  const lines = [
    ARTIFACT_COMMENT_MARKER,
    "## Artifacts & verification",
    "",
    `Run: ${last?.runId ?? "local"} · Commit: ${last?.commitSha ? `\`${last.commitSha}\`` : "unavailable"}`,
    "",
  ];
  for (const selection of policy.publish.select) {
    const artifact = artifacts.find((entry) => entry.key === selection.key);
    // Conditional steps (e.g. screenshots only for UI changes) select keys that most runs never capture.
    if (!artifact && selection.optional) continue;
    const title = artifact?.title ?? selection.key;
    const section = [`### ${title}`, ""];
    if (!artifact) {
      section.push("Not captured.");
    } else {
      section.push(
        `Produced by \`${artifact.step}\`, execution ${artifact.iteration}${artifact.commitSha ? ` at \`${artifact.commitSha}\`` : ""}.`,
        "",
      );
      const url = urls.get(artifact.key);
      if (selection.presentation === "embed" || selection.presentation === "link") {
        section.push(
          url
            ? `${selection.presentation === "embed" ? "!" : ""}[${title}](${url})`
            : failures.has(artifact.key)
              ? `Captured locally; upload failed: ${sanitizeStatus(failures.get(artifact.key)!)}`
              : "Captured locally; no upload URL is available.",
        );
        // Tell reviewers who can open the file (e.g. link-public GitLab media on a private project).
        if (url && artifact.upload?.status === "uploaded" && artifact.upload.notice)
          section.push("", `_Access: ${sanitizeStatus(artifact.upload.notice)}_`);
      } else {
        const text = registry.readText(artifact.id);
        if (text === null) {
          section.push(
            "Preview unavailable or too large; inspect this artifact in the local dashboard.",
          );
        } else {
          const content = resolveArtifactReferences(text, (key) => {
            const target = artifacts.find((entry) => entry.key === key);
            return !target || !artifact.commitSha || target.commitSha === artifact.commitSha
              ? urls.get(key)
              : undefined;
          });
          let fenceLength = 3;
          for (const match of content.matchAll(/`+/g))
            fenceLength = Math.max(fenceLength, match[0].length + 1);
          const fence = "`".repeat(fenceLength);
          const rendered =
            artifact.mediaType === "text/markdown" ? content : `${fence}\n${content}\n${fence}`;
          section.push(
            selection.presentation === "collapsed"
              ? `<details>\n<summary>Show artifact</summary>\n\n${rendered}\n\n</details>`
              : rendered,
          );
        }
      }
    }
    const renderedSection = section.join("\n");
    if (lines.join("\n").length + renderedSection.length > MAX_COMMENT_CHARS - 200) {
      lines.push("Further artifacts omitted because they exceed the comment preview budget.");
      break;
    }
    lines.push(renderedSection, "");
  }
  return { body: lines.join("\n"), ids: artifacts.map((artifact) => artifact.id) };
}
