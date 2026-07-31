import { describe, expect, test } from "bun:test";

import { GitHubReviewsClient } from "../src/lib/github-reviews";

/**
 * userHasPushAccess gates mention-triggered automation: only users who can
 * push (write/maintain/admin) may direct the agent. It must fail closed.
 */
describe("GitHubReviewsClient.userHasPushAccess", () => {
  function clientWithPermission(result: { permission: string; roleName?: string } | Error) {
    const client = new GitHubReviewsClient({ token: "test-token" });
    (client as any).getCollaboratorPermission = async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    };
    return client;
  }

  test("grants write permission", async () => {
    const client = clientWithPermission({ permission: "write" });
    expect(await client.userHasPushAccess("acme", "widgets", "dev")).toBe(true);
  });

  test("grants admin permission", async () => {
    const client = clientWithPermission({ permission: "admin" });
    expect(await client.userHasPushAccess("acme", "widgets", "owner")).toBe(true);
  });

  test("grants fine-grained maintain role", async () => {
    const client = clientWithPermission({ permission: "read", roleName: "maintain" });
    expect(await client.userHasPushAccess("acme", "widgets", "maintainer")).toBe(true);
  });

  test("denies read-only users", async () => {
    const client = clientWithPermission({ permission: "read" });
    expect(await client.userHasPushAccess("acme", "widgets", "drive-by")).toBe(false);
  });

  test("denies triage role (cannot push)", async () => {
    const client = clientWithPermission({ permission: "read", roleName: "triage" });
    expect(await client.userHasPushAccess("acme", "widgets", "triager")).toBe(false);
  });

  test("denies non-collaborators", async () => {
    const client = clientWithPermission({ permission: "none" });
    expect(await client.userHasPushAccess("acme", "widgets", "stranger")).toBe(false);
  });

  test("fails closed on API errors", async () => {
    const client = clientWithPermission(new Error("boom"));
    expect(await client.userHasPushAccess("acme", "widgets", "anyone")).toBe(false);
  });
});
