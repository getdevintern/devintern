/** Registered run outputs only; never infer ownership by scanning a task directory. */
import { ArtifactStore, isTextArtifact, MAX_ARTIFACT_TEXT_BYTES } from "../artifacts/store";
import { resolveArtifactReferences } from "../artifacts/publication";
import type { RunArtifact } from "../artifacts/types";

export type TaskArtifactFile = RunArtifact;
export interface TaskArtifactContent {
  name: string;
  content: string | null;
  truncated: boolean;
  totalBytes: number;
}

export function listRunArtifacts(dbPath: string, runId: number): RunArtifact[] {
  let store: ArtifactStore | undefined;
  try {
    store = new ArtifactStore(dbPath, { readonly: true });
    return store.list(runId);
  } catch {
    return [];
  } finally {
    store?.close();
  }
}

export function readRunArtifact(
  dbPath: string,
  runId: number,
  id: string,
): TaskArtifactContent | null {
  let store: ArtifactStore | undefined;
  try {
    store = new ArtifactStore(dbPath, { readonly: true });
    const artifacts = store.list(runId);
    const artifact = artifacts.find((entry) => entry.id === id);
    if (!artifact) return null;
    const bytes = store.read(artifact);
    if (!bytes) return null;
    let content = isTextArtifact(artifact.mediaType)
      ? bytes.subarray(0, MAX_ARTIFACT_TEXT_BYTES).toString("utf8")
      : null;
    if (content !== null && artifact.mediaType === "text/markdown")
      content = resolveArtifactReferences(content, (key) => {
        const match = artifacts
          .filter(
            (entry) =>
              entry.key === key &&
              entry.available &&
              (!artifact.commitSha || entry.commitSha === artifact.commitSha),
          )
          .at(-1);
        return match ? `/api/runs/${runId}/artifacts/${match.id}/file` : undefined;
      });
    return {
      name: artifact.name,
      content,
      truncated: content !== null && bytes.length > MAX_ARTIFACT_TEXT_BYTES,
      totalBytes: bytes.length,
    };
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/** Safe raster previews; active formats (HTML/SVG) are always downloads. */
export function readRunArtifactFile(
  dbPath: string,
  runId: number,
  id: string,
  download: boolean,
): Response {
  let store: ArtifactStore | undefined;
  try {
    store = new ArtifactStore(dbPath, { readonly: true });
    const artifact = store.list(runId).find((entry) => entry.id === id);
    const bytes = artifact && store.read(artifact);
    if (!artifact || !bytes) return Response.json({ error: "artifact not found" }, { status: 404 });
    const preview =
      !download &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(artifact.mediaType);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": preview ? artifact.mediaType : "application/octet-stream",
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "artifact not found" }, { status: 404 });
  } finally {
    store?.close();
  }
}
