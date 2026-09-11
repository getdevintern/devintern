import { describe, expect, test } from "bun:test";
import { GitLabReviewsClient } from "../src/lib/gitlab-reviews";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 17,
    title: "Improve widgets",
    state: "opened",
    sha: "abc123",
    source_branch: "feature/widgets",
    target_branch: "main",
    source_project_id: 42,
    target_project_id: 42,
    web_url: "https://gitlab.com/acme/widgets/-/merge_requests/17",
    ...overrides,
  };
}

function note(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    body: `Feedback ${id}`,
    author: { id: id + 100, username: `reviewer${id}`, state: "active" },
    created_at: "2026-09-09T00:00:00Z",
    system: false,
    resolvable: true,
    resolved: false,
    position: { new_path: "src/widget.ts", new_line: id },
    ...overrides,
  };
}

function clientFor(
  discussions: unknown[],
  options: { mr?: Record<string, unknown>; accessLevel?: number; canPush?: boolean } = {},
): { client: GitLabReviewsClient; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/user")) return json({ id: 7, username: "devintern-bot" });
    if (url.includes("/projects/acme%2Fwidgets")) {
      return json({
        id: 42,
        path_with_namespace: "acme/widgets",
        permissions: { project_access: { access_level: options.accessLevel ?? 30 } },
      });
    }
    if (url.endsWith("/merge_requests/17")) return json(fixture(options.mr));
    if (url.includes("/repository/branches/")) {
      return json({ name: "feature/widgets", can_push: options.canPush ?? true });
    }
    if (url.includes("/discussions?")) return json(discussions);
    if (url.includes("/discussions/") && url.endsWith("/notes")) return json({ id: 999 });
    throw new Error(`Unexpected request: ${url}`);
  };
  return {
    client: new GitLabReviewsClient("token", "https://gitlab.com", { fetch }),
    calls,
  };
}

describe("GitLabReviewsClient", () => {
  test("normalizes unresolved human inline and top-level feedback", async () => {
    const { client } = clientFor([
      {
        id: "inline",
        individual_note: false,
        notes: [note(1), note(2, { author: { id: 7, username: "devintern-bot" } })],
      },
      {
        id: "conversation",
        individual_note: true,
        notes: [note(3, { resolvable: false, position: null })],
      },
      {
        id: "resolved",
        individual_note: false,
        notes: [note(4, { resolved: true })],
      },
      {
        id: "system",
        individual_note: true,
        notes: [note(5, { system: true, resolvable: false, position: null })],
      },
      {
        id: "bot",
        individual_note: true,
        notes: [
          note(6, {
            author: { id: 106, username: "project-bot", bot: true },
            resolvable: false,
            position: null,
          }),
        ],
      },
    ]);

    const context = await client.getReviewContext("acme/widgets", 17);
    expect(context.feedback.comments).toEqual([
      expect.objectContaining({ id: 1, path: "src/widget.ts", line: 1, side: "RIGHT" }),
    ]);
    expect(context.feedback.conversationComments).toEqual([
      expect.objectContaining({ id: 3, author: "reviewer3" }),
    ]);
    expect(context.discussionIds).toEqual(["inline", "conversation"]);
    expect(context.discussionByNoteId).toEqual({ 1: "inline", 3: "conversation" });
    expect(context.feedback.reviewState).toBe("changes_requested");
  });

  test("rejects forks before checking branch writability", async () => {
    const { client, calls } = clientFor([], {
      mr: { source_project_id: 99, target_project_id: 42 },
    });
    await expect(client.getReviewContext("acme/widgets", 17)).rejects.toThrow(
      "Fork merge requests are not supported",
    );
    expect(calls.some((call) => call.url.includes("/repository/branches/"))).toBe(false);
  });

  test("fails closed without Developer access or source-branch push permission", async () => {
    const lowAccess = clientFor([], { accessLevel: 20 });
    await expect(lowAccess.client.getReviewContext("acme/widgets", 17)).rejects.toThrow(
      "Developer-or-higher",
    );

    const protectedBranch = clientFor([], { canPush: false });
    await expect(protectedBranch.client.getReviewContext("acme/widgets", 17)).rejects.toThrow(
      "cannot push to source branch",
    );
  });

  test("revalidates the exact head SHA before push", async () => {
    const stable = clientFor([]);
    await expect(stable.client.assertHeadSha(42, 17, "abc123")).resolves.toBeUndefined();

    const advanced = clientFor([], { mr: { sha: "def456" } });
    await expect(advanced.client.assertHeadSha(42, 17, "abc123")).rejects.toThrow(
      "MR head changed",
    );
  });

  test("replies to discussions without resolving them", async () => {
    const { client, calls } = clientFor([]);
    const result = await client.replyToDiscussions(42, 17, ["abc", "def"], "Addressed");
    const replies = calls.filter((call) => call.url.endsWith("/notes"));
    expect(replies).toHaveLength(2);
    expect(replies.every((call) => call.init?.method === "POST")).toBe(true);
    expect(replies.every((call) => call.init?.body === JSON.stringify({ body: "Addressed" }))).toBe(
      true,
    );
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
    expect(result).toEqual({ replied: 2, failures: [] });
  });

  test("paginates discussions", async () => {
    let page = 0;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/user")) return json({ id: 7, username: "devintern-bot" });
      if (url.includes("/projects/acme%2Fwidgets")) {
        return json({
          id: 42,
          path_with_namespace: "acme/widgets",
          permissions: { project_access: { access_level: 30 } },
        });
      }
      if (url.endsWith("/merge_requests/17")) return json(fixture());
      if (url.includes("/repository/branches/")) return json({ can_push: true });
      if (url.includes("/discussions?")) {
        page++;
        return json(
          [{ id: `page-${page}`, individual_note: false, notes: [note(page)] }],
          page === 1 ? { headers: { "x-next-page": "2" } } : {},
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = new GitLabReviewsClient("token", "https://gitlab.com", { fetch });
    const context = await client.getReviewContext("acme/widgets", 17);
    expect(context.noteIds).toEqual([1, 2]);
  });

  test("polling exposes only unresolved human discussion roots and reviewer ids", async () => {
    const { client } = clientFor(
      [
        { id: "open", individual_note: false, notes: [note(1)] },
        { id: "resolved", individual_note: false, notes: [note(2, { resolved: true })] },
        {
          id: "top-level",
          individual_note: true,
          notes: [note(3, { resolvable: false, position: null })],
        },
        {
          id: "own",
          individual_note: false,
          notes: [note(4, { author: { id: 7, username: "devintern-bot" } })],
        },
      ],
      { mr: { reviewers: [{ id: 8, username: "reviewer" }] } },
    );
    const result = await client.getPollingSnapshot(42, 17);
    expect(result.assignedReviewerIds).toEqual([8]);
    expect(result.feedback).toEqual([expect.objectContaining({ discussionId: "open", noteId: 1 })]);
  });

  test("maps GitLab mergeability without using GitHub state strings", async () => {
    const { client } = clientFor([], {
      mr: {
        detailed_merge_status: "conflict",
        diff_refs: { base_sha: "base123", head_sha: "abc123" },
      },
    });
    const result = await client.getChangeRequest("acme/widgets", 17);
    expect(result).toMatchObject({
      mergeability: "conflicts",
      head: { ref: "feature/widgets", sha: "abc123" },
      base: { ref: "main", sha: "base123" },
    });
  });
});
