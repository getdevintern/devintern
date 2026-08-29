import { describe, expect, test } from "bun:test";

import { buildTicketUrl } from "../src/lib/ticket-url";

describe("buildTicketUrl", () => {
  test("derives a Jira browse URL from JIRA_BASE_URL", () => {
    expect(buildTicketUrl("jira", "ENG-42", { JIRA_BASE_URL: "https://acme.atlassian.net" })).toBe(
      "https://acme.atlassian.net/browse/ENG-42",
    );
  });

  test("strips a trailing slash from the Jira base URL", () => {
    expect(buildTicketUrl("jira", "ENG-42", { JIRA_BASE_URL: "https://acme.atlassian.net/" })).toBe(
      "https://acme.atlassian.net/browse/ENG-42",
    );
  });

  test("rejects non-Jira-shaped keys even with config", () => {
    const env = { JIRA_BASE_URL: "https://acme.atlassian.net" };
    expect(buildTicketUrl("jira", "12345", env)).toBeUndefined();
    expect(buildTicketUrl("jira", "scheduled-20260827T120000", env)).toBeUndefined();
  });

  test("returns undefined for a Jira run when the base URL is missing", () => {
    expect(buildTicketUrl("jira", "ENG-42", {})).toBeUndefined();
  });

  test("derives GitHub, GitLab, Azure DevOps, Asana, and Trello URLs", () => {
    expect(buildTicketUrl("github", "12", { GITHUB_REPO: "acme/widgets" })).toBe(
      "https://github.com/acme/widgets/issues/12",
    );
    expect(buildTicketUrl("gitlab", "7", { GITLAB_PROJECT: "acme/widgets" })).toBe(
      "https://gitlab.com/acme/widgets/-/issues/7",
    );
    expect(
      buildTicketUrl("gitlab", "7", {
        GITLAB_PROJECT: "acme/widgets",
        GITLAB_BASE_URL: "https://gitlab.internal.example/",
      }),
    ).toBe("https://gitlab.internal.example/acme/widgets/-/issues/7");
    expect(
      buildTicketUrl("azure-devops", "99", {
        AZURE_DEVOPS_ORG: "acme corp",
        AZURE_DEVOPS_PROJECT: "Web Widgets",
      }),
    ).toBe(
      `https://dev.azure.com/${encodeURIComponent("acme corp")}/${encodeURIComponent("Web Widgets")}/_workitems/edit/99`,
    );
    expect(buildTicketUrl("asana", "1208823756377924", {})).toBe(
      "https://app.asana.com/0/0/1208823756377924",
    );
    expect(buildTicketUrl("trello", "a1b2c3d4", {})).toBe("https://trello.com/c/a1b2c3d4");
  });

  test("requires config for derived URLs (GitHub/GitLab/Azure)", () => {
    expect(buildTicketUrl("github", "12", {})).toBeUndefined();
    expect(
      buildTicketUrl("github", "not-a-number", { GITHUB_REPO: "acme/widgets" }),
    ).toBeUndefined();
    expect(buildTicketUrl("gitlab", "7", {})).toBeUndefined();
    expect(buildTicketUrl("azure-devops", "99", { AZURE_DEVOPS_ORG: "acme" })).toBeUndefined();
  });

  test("linear and markdown trackers have no derivable URL", () => {
    expect(buildTicketUrl("linear", "ENG-42", { LINEAR_API_KEY: "key" })).toBeUndefined();
    expect(buildTicketUrl("markdown", "task-20260827", {})).toBeUndefined();
  });

  test("unknown tracker type and missing inputs yield no URL", () => {
    expect(buildTicketUrl("unknown-tracker", "ENG-42", {})).toBeUndefined();
    expect(buildTicketUrl(undefined, "ENG-42", {})).toBeUndefined();
    expect(buildTicketUrl("jira", undefined, {})).toBeUndefined();
    expect(buildTicketUrl("", "", {})).toBeUndefined();
  });
});
