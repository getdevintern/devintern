import { Utils } from "../../utils";
import { ARTIFACT_COMMENT_MARKER } from "../../artifacts/publication";
import type { ArtifactPublication } from "../../artifacts/types";

/** Update one authenticated author's managed comment, including when the PR already exists. */
export async function upsertArtifactComment(input: {
  token: string;
  baseUrl: string;
  repository: string;
  number: number;
  body: string;
  authorLogin?: string;
}): Promise<ArtifactPublication> {
  try {
    const headers = {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "devintern",
    };
    const request = async (path: string, options: RequestInit = {}): Promise<Response> => {
      const response = await Utils.fetchWithRetry(
        `${input.baseUrl}${path}`,
        {
          ...options,
          headers,
        },
        options.method === "POST" ? { maxRetries: 0 } : undefined,
      );
      if (!response.ok)
        throw new Error(`GitHub artifact comment request failed (${response.status})`);
      return response;
    };
    const login =
      input.authorLogin ?? ((await (await request("/user")).json()) as { login: string }).login;
    if (!login) throw new Error("Cannot determine artifact comment author");
    const repoPath = `/repos/${input.repository}`;
    let existing: { id: number; body: string } | undefined;
    for (let page = 1; page <= 100; page++) {
      const response = await request(
        `${repoPath}/issues/${input.number}/comments?per_page=100&page=${page}`,
      );
      const comments = (await response.json()) as {
        id: number;
        body: string;
        user: { login: string };
      }[];
      existing = comments.find(
        (comment) =>
          comment.user.login === login && comment.body.startsWith(ARTIFACT_COMMENT_MARKER),
      );
      if (existing || comments.length < 100) break;
      if (page === 100) throw new Error("Artifact comment search exceeded pagination limit");
    }
    const response = await request(
      existing
        ? `${repoPath}/issues/comments/${existing.id}`
        : `${repoPath}/issues/${input.number}/comments`,
      {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify({ body: input.body }),
      },
    );
    const comment = (await response.json()) as { id: number; html_url: string };
    return { status: "published", commentId: comment.id, commentUrl: comment.html_url };
  } catch (error) {
    return { status: "failed", message: (error as Error).message };
  }
}
