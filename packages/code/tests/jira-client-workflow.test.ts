import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import path from "path";
import { JiraTaskTrackerClient as JiraClient } from "../src/lib/trackers/jira/jira-task-tracker-client";

describe("JiraClient workflow methods", () => {
  let client: JiraClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join("/tmp", `devintern-jira-workflow-${Date.now()}-${Math.random()}`);
    process.env.DEVINTERN_OUTPUT_DIR = tempDir;
    client = new JiraClient("https://test.atlassian.net", "test@example.com", "test-token");
  });

  afterEach(() => {
    delete process.env.DEVINTERN_OUTPUT_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("postImplementationComment posts ADF comment body", async () => {
    let capturedBody: unknown;

    client.jiraApiCall = async (method, url, body) => {
      expect(method).toBe("POST");
      expect(url).toBe("/rest/api/3/issue/TEST-1/comment");
      capturedBody = body;
      return { id: "100" };
    };

    await client.postImplementationComment("TEST-1", "Done!", "Add login");

    expect(capturedBody).toMatchObject({
      body: {
        type: "doc",
        version: 1,
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "heading",
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining("Implementation Completed by @devintern/code"),
              }),
            ]),
          }),
        ]),
      },
    });
  });

  test("postClarityComment posts ADF assessment body", async () => {
    let capturedBody: unknown;

    client.jiraApiCall = async (method, url, body) => {
      expect(method).toBe("POST");
      expect(url).toBe("/rest/api/3/issue/TEST-2/comment");
      capturedBody = body;
      return { id: "101" };
    };

    await client.postClarityComment("TEST-2", {
      clarityScore: 8,
      isImplementable: true,
      summary: "Clear task",
      issues: [],
      recommendations: [],
    });

    expect(capturedBody).toMatchObject({
      body: {
        type: "doc",
        version: 1,
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "heading",
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining("Automated Task Feasibility Assessment"),
              }),
            ]),
          }),
        ]),
      },
    });
  });

  test("postIncompleteImplementationComment saves task description for dedup", async () => {
    client.jiraApiCall = async () => ({ id: "102" });

    const description = "Original task description text";
    await client.postIncompleteImplementationComment(
      "TEST-3",
      "Could not finish",
      "Summary line",
      description,
    );

    const descriptionFile = path.join(tempDir, "test-3", "incomplete-task-description.txt");
    expect(existsSync(descriptionFile)).toBe(true);
    expect(readFileSync(descriptionFile, "utf8")).toBe(description);
  });
});
