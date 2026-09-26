import { describe, expect, test } from "bun:test";

import { GitLabWebhookAdminClient } from "../src/lib/code-host/gitlab/webhook-admin";

interface Call {
  url: string;
  init?: RequestInit;
}

function mockFetch(responses: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  return {
    calls,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return responses[index++] ?? new Response("missing mock", { status: 500 });
    }) as typeof fetch,
  };
}

describe("GitLabWebhookAdminClient", () => {
  test("resolves immutable project identity and enforces Maintainer access", async () => {
    const maintained = mockFetch([
      Response.json({
        id: 42,
        path_with_namespace: "platform/widgets",
        permissions: { group_access: { access_level: 40 } },
      }),
    ]);
    const client = new GitLabWebhookAdminClient("local-token", "https://gitlab.example.com", {
      fetch: maintained.fetch,
    });
    expect(await client.resolveMaintainedProject("platform/widgets")).toEqual({
      id: 42,
      path: "platform/widgets",
      accessLevel: 40,
    });
    expect(maintained.calls[0]?.init?.headers).toMatchObject({ "PRIVATE-TOKEN": "local-token" });

    const developer = mockFetch([
      Response.json({
        id: 42,
        path_with_namespace: "platform/widgets",
        permissions: { project_access: { access_level: 30 } },
      }),
    ]);
    await expect(
      new GitLabWebhookAdminClient("token", "https://gitlab.example.com", {
        fetch: developer.fetch,
      }).resolveMaintainedProject("platform/widgets"),
    ).rejects.toThrow("GITLAB_WEBHOOK_ADMIN_TOKEN");
  });

  test("creates a signed hook on GitLab 19+ and tests delivery", async () => {
    const mock = mockFetch([
      Response.json({ version: "19.1.0" }),
      Response.json({ id: 7, url: "https://relay.example.com/ingest/gitlab/new" }),
      new Response(null, { status: 201 }),
    ]);
    const client = new GitLabWebhookAdminClient("token", "https://gitlab.example.com", {
      fetch: mock.fetch,
    });
    const result = await client.upsertRelayHook(42, {
      ingestUrl: "https://relay.example.com/ingest/gitlab/new",
      legacySecret: "legacy",
      signingToken: "whsec_c2lnbg==",
    });
    expect(result).toMatchObject({ hook: { id: 7 }, standardSigning: true });
    const body = JSON.parse(String(mock.calls[1]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      token: "legacy",
      signing_token: "whsec_c2lnbg==",
      note_events: true,
      merge_requests_events: true,
      pipeline_events: true,
      job_events: true,
      enable_ssl_verification: true,
    });
    await client.testHook(42, 7);
    expect(mock.calls[2]?.url).toEndWith("/projects/42/hooks/7/test/note_events");
  });

  test("falls back to legacy secrets when signing_token is rejected", async () => {
    const mock = mockFetch([
      Response.json({ version: "19.0.0" }),
      Response.json({ message: "signing_token is not supported" }, { status: 400 }),
      Response.json({ id: 7, url: "https://relay.example.com/ingest/gitlab/new" }),
    ]);
    const result = await new GitLabWebhookAdminClient("token", "https://gitlab.example.com", {
      fetch: mock.fetch,
    }).upsertRelayHook(42, {
      ingestUrl: "https://relay.example.com/ingest/gitlab/new",
      legacySecret: "legacy",
      signingToken: "whsec_c2lnbg==",
    });
    expect(result.standardSigning).toBe(false);
    expect(JSON.parse(String(mock.calls[2]?.init?.body))).not.toHaveProperty("signing_token");
  });

  test("updates only a remembered DevIntern hook and never adopts an unrelated hook", async () => {
    const managed = mockFetch([
      Response.json({ version: "18.8.0" }),
      Response.json({ id: 7, name: "DevIntern Relay", url: "https://relay.old/hook" }),
      Response.json({ id: 7, name: "DevIntern Relay", url: "https://relay.example/new" }),
    ]);
    await new GitLabWebhookAdminClient("token", "https://gitlab.example.com", {
      fetch: managed.fetch,
    }).upsertRelayHook(42, { ingestUrl: "https://relay.example/new", legacySecret: "legacy" }, 7);
    expect(managed.calls[2]?.init?.method).toBe("PUT");

    const unrelated = mockFetch([
      Response.json({ version: "18.8.0" }),
      Response.json({ id: 8, name: "Other", url: "https://example.com/hook" }),
      Response.json({ id: 9, name: "DevIntern Relay", url: "https://relay.example/new" }),
    ]);
    await new GitLabWebhookAdminClient("token", "https://gitlab.example.com", {
      fetch: unrelated.fetch,
    }).upsertRelayHook(42, { ingestUrl: "https://relay.example/new", legacySecret: "legacy" }, 8);
    expect(unrelated.calls[2]?.init?.method).toBe("POST");
  });

  test("lists, retrieves, and deletes project-scoped hooks", async () => {
    const mock = mockFetch([
      Response.json([{ id: 7, url: "https://relay.example/hook" }]),
      new Response(null, { status: 404 }),
      new Response(null, { status: 204 }),
    ]);
    const client = new GitLabWebhookAdminClient("token", "https://gitlab.example.com", {
      fetch: mock.fetch,
    });
    expect(await client.listHooks(42)).toHaveLength(1);
    expect(await client.getHook(42, 99)).toBeNull();
    expect(await client.deleteHook(42, 7)).toBe(true);
  });
});
