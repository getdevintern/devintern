import { describe, test, expect, beforeEach } from "bun:test";
import { JiraTaskTrackerClient as JiraClient } from "../src/lib/trackers/jira/jira-task-tracker-client";
import { JiraFormatter } from "../src/lib/trackers/jira/jira-formatter";
import type { JiraComment } from "../src/types/jira";

describe("JiraClient Comment Filtering", () => {
  let jiraClient: JiraClient;

  beforeEach(() => {
    // Create a JiraClient instance for testing
    jiraClient = new JiraClient("https://test.atlassian.net", "test@example.com", "test-token");
  });

  describe("isDevInternComment - String Body Format", () => {
    test("should detect implementation completed comment", () => {
      const comment: JiraComment = {
        id: "1",
        body: "🤖 Implementation Completed by @devintern/code - I've added the feature",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      // Access private method via reflection for testing
      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should detect clarity assessment comment", () => {
      const comment: JiraComment = {
        id: "2",
        body: "🤖 Automated Task Feasibility Assessment - Score: 8/10",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should detect incomplete implementation comment", () => {
      const comment: JiraComment = {
        id: "3",
        body: "⚠️ Implementation Incomplete - Could not finish the task",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should NOT detect regular user comment", () => {
      const comment: JiraComment = {
        id: "4",
        body: "Please implement this feature as soon as possible",
        author: { accountId: "john-doe", displayName: "John Doe" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });

    test("should NOT detect comment mentioning Agent but not automated", () => {
      const comment: JiraComment = {
        id: "5",
        body: "I think Claude should work on this task next week",
        author: { accountId: "jane-smith", displayName: "Jane Smith" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });
  });

  describe("isDevInternComment - Rendered Body Format", () => {
    test("should detect implementation comment in renderedBody", () => {
      const comment: JiraComment = {
        id: "6",
        body: "",
        renderedBody:
          "<h3>🤖 Implementation Completed by @devintern/code</h3><p>Task completed successfully</p>",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should detect assessment comment in renderedBody", () => {
      const comment: JiraComment = {
        id: "7",
        body: "",
        renderedBody: "<h3>🤖 Automated Task Feasibility Assessment</h3><p>Clarity: 8/10</p>",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should detect incomplete comment in renderedBody", () => {
      const comment: JiraComment = {
        id: "8",
        body: "",
        renderedBody: "<h3>⚠️ Implementation Incomplete</h3><p>Could not complete</p>",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });
  });

  describe("isDevInternComment - ADF Body Format", () => {
    test("should detect implementation comment in ADF format", () => {
      const adfContent = JiraFormatter.createImplementationCommentADF(
        "Implementation completed successfully",
        "Add login feature",
      );

      const comment: JiraComment = {
        id: "9",
        body: {
          type: "doc",
          version: 1,
          content: adfContent,
        },
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should detect assessment comment in ADF format", () => {
      const adfContent = JiraFormatter.createClarityAssessmentADF({
        clarityScore: 8,
        isImplementable: true,
        summary: "Task is clear",
        issues: [],
        recommendations: [],
      });

      const comment: JiraComment = {
        id: "10",
        body: {
          type: "doc",
          version: 1,
          content: adfContent,
        },
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should detect incomplete comment in ADF format", () => {
      const adfContent = JiraFormatter.createIncompleteImplementationCommentADF(
        "Could not complete the task",
        "Add login feature",
      );

      const comment: JiraComment = {
        id: "11",
        body: {
          type: "doc",
          version: 1,
          content: adfContent,
        },
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should NOT detect regular comment in ADF format", () => {
      const comment: JiraComment = {
        id: "12",
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "This is a regular user comment about the task",
                },
              ],
            },
          ],
        },
        author: { accountId: "john-doe", displayName: "John Doe" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty body", () => {
      const comment: JiraComment = {
        id: "13",
        body: "",
        author: { accountId: "test-user", displayName: "Test User" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });

    test("should handle undefined body", () => {
      const comment: JiraComment = {
        id: "14",
        body: undefined as any,
        author: { accountId: "test-user", displayName: "Test User" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });

    test("should handle null body", () => {
      const comment: JiraComment = {
        id: "15",
        body: null as any,
        author: { accountId: "test-user", displayName: "Test User" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });

    test("should handle malformed ADF body", () => {
      const comment: JiraComment = {
        id: "16",
        body: {
          type: "doc",
          version: 1,
          // Missing content field
        } as any,
        author: { accountId: "test-user", displayName: "Test User" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });

    test("should be case sensitive for markers", () => {
      const comment: JiraComment = {
        id: "17",
        body: "implementation completed by @devintern/code",
        author: { accountId: "test-user", displayName: "Test User" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });

    test("should detect marker even with surrounding text", () => {
      const comment: JiraComment = {
        id: "18",
        body: "Here is some text before. Implementation Completed by @devintern/code. And some after.",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(true);
    });

    test("should detect marker with different whitespace", () => {
      const comment: JiraComment = {
        id: "19",
        body: "Implementation   Completed   by   @devintern/code",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      // This should NOT match because we check for exact string
      const isDevInternComment = (jiraClient as any).isDevInternComment(comment);
      expect(isDevInternComment).toBe(false);
    });
  });

  describe("All Three Comment Types", () => {
    test("should correctly identify all three automated comment types", () => {
      const implementationComment: JiraComment = {
        id: "20",
        body: "🤖 Implementation Completed by @devintern/code",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const assessmentComment: JiraComment = {
        id: "21",
        body: "🤖 Automated Task Feasibility Assessment",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const incompleteComment: JiraComment = {
        id: "22",
        body: "⚠️ Implementation Incomplete",
        author: { accountId: "devintern-bot", displayName: "@devintern/code" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      const regularComment: JiraComment = {
        id: "23",
        body: "Regular user feedback",
        author: { accountId: "john-doe", displayName: "John Doe" },
        created: "2024-01-01",
        updated: "2024-01-01",
      };

      expect((jiraClient as any).isDevInternComment(implementationComment)).toBe(true);
      expect((jiraClient as any).isDevInternComment(assessmentComment)).toBe(true);
      expect((jiraClient as any).isDevInternComment(incompleteComment)).toBe(true);
      expect((jiraClient as any).isDevInternComment(regularComment)).toBe(false);
    });
  });

  describe("Marker Uniqueness", () => {
    test("markers should be unique substrings of each comment type", () => {
      const markers = [
        "Implementation Completed by @devintern/code",
        "Automated Task Feasibility Assessment",
        "Implementation Incomplete",
      ];

      // Ensure no marker is a substring of another
      for (let i = 0; i < markers.length; i++) {
        for (let j = 0; j < markers.length; j++) {
          if (i !== j) {
            expect(markers[i].includes(markers[j])).toBe(false);
            expect(markers[j].includes(markers[i])).toBe(false);
          }
        }
      }
    });

    test("each marker should appear in exactly one comment type", () => {
      const implementationADF = JiraFormatter.createImplementationCommentADF("test");
      const assessmentADF = JiraFormatter.createClarityAssessmentADF({
        clarityScore: 5,
        isImplementable: true,
        summary: "test",
        issues: [],
        recommendations: [],
      });
      const incompleteADF = JiraFormatter.createIncompleteImplementationCommentADF("test");

      const implementationStr = JSON.stringify(implementationADF);
      const assessmentStr = JSON.stringify(assessmentADF);
      const incompleteStr = JSON.stringify(incompleteADF);

      // Implementation marker should only appear in implementation comments
      expect(implementationStr).toContain("Implementation Completed by @devintern/code");
      expect(assessmentStr).not.toContain("Implementation Completed by @devintern/code");
      expect(incompleteStr).not.toContain("Implementation Completed by @devintern/code");

      // Assessment marker should only appear in assessment comments
      expect(implementationStr).not.toContain("Automated Task Feasibility Assessment");
      expect(assessmentStr).toContain("Automated Task Feasibility Assessment");
      expect(incompleteStr).not.toContain("Automated Task Feasibility Assessment");

      // Incomplete marker should only appear in incomplete comments
      expect(implementationStr).not.toContain("Implementation Incomplete");
      expect(assessmentStr).not.toContain("Implementation Incomplete");
      expect(incompleteStr).toContain("Implementation Incomplete");
    });
  });

  describe("getComments integration", () => {
    test("filters @devintern/code automation comments from API response", async () => {
      jiraClient.jiraApiCall = async () => ({
        comments: [
          {
            id: "1",
            body: "Please review this change",
            author: { displayName: "Human" },
            created: "2024-01-01",
            updated: "2024-01-01",
          },
          {
            id: "2",
            body: "🤖 Implementation Completed by @devintern/code",
            author: { displayName: "@devintern/code" },
            created: "2024-01-02",
            updated: "2024-01-02",
          },
          {
            id: "3",
            body: "Another human comment",
            author: { displayName: "Human" },
            created: "2024-01-03",
            updated: "2024-01-03",
          },
        ],
      });

      const comments = await jiraClient.getComments("TEST-1");
      expect(comments).toHaveLength(2);
      expect(comments.map((c) => c.id)).toEqual(["1", "3"]);
    });

    test("returns empty array when API returns no comments", async () => {
      jiraClient.jiraApiCall = async () => ({ comments: [] });

      const comments = await jiraClient.getComments("TEST-1");
      expect(comments).toEqual([]);
    });
  });
});
