import { ARTIFACT_COMMENT_MARKER } from "../../artifacts/publication";
import type { ArtifactPublication } from "../../artifacts/types";
import type { GitLabApi } from "./api";

interface GitLabNote {
  id: number;
  body: string;
  system?: boolean;
  author?: { id: number };
}

/**
 * Create or update the authenticated user's managed artifact note on a merge
 * request. Never touches the MR description or notes by other authors.
 */
export async function upsertArtifactNote(input: {
  api: GitLabApi;
  projectId: number;
  mergeRequestIid: number;
  webUrl: string;
  body: string;
}): Promise<ArtifactPublication> {
  try {
    const me = await input.api.json<{ id?: number }>("/user");
    if (!me.id) throw new Error("Cannot determine artifact note author");
    const notesPath = `/projects/${input.projectId}/merge_requests/${input.mergeRequestIid}/notes`;
    let existing: GitLabNote | undefined;
    for (let page = 1; page <= 100; page++) {
      const notes = await input.api.json<GitLabNote[]>(
        `${notesPath}?per_page=100&page=${page}&sort=asc&order_by=created_at`,
      );
      existing = notes.find(
        (note) =>
          !note.system &&
          note.author?.id === me.id &&
          note.body.startsWith(ARTIFACT_COMMENT_MARKER),
      );
      if (existing || notes.length < 100) break;
      if (page === 100) throw new Error("Artifact note search exceeded pagination limit");
    }
    const note = await input.api.json<GitLabNote>(
      existing ? `${notesPath}/${existing.id}` : notesPath,
      { method: existing ? "PUT" : "POST", body: JSON.stringify({ body: input.body }) },
      existing ? undefined : { maxRetries: 0 },
    );
    return {
      status: "published",
      commentId: note.id,
      commentUrl: `${input.webUrl}#note_${note.id}`,
    };
  } catch (error) {
    return {
      status: "failed",
      message: `GitLab artifact note failed: ${(error as Error).message}`,
    };
  }
}
