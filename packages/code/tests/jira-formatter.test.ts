import { describe, test, expect } from "bun:test";
import { JiraFormatter } from "../src/lib/trackers/jira/jira-formatter";

describe("JiraFormatter - @devintern/code Comment Markers", () => {
  test("createImplementationCommentADF should include marker", () => {
    const output = "I've successfully implemented the feature";
    const taskSummary = "Add login functionality";

    const adf = JiraFormatter.createImplementationCommentADF(output, taskSummary);

    // Should have header with robot emoji
    expect(adf[0].type).toBe("heading");
    expect(adf[0].content[0].type).toBe("emoji");
    expect(adf[0].content[1].text).toContain("Implementation Completed by @devintern/code");

    // Verify marker text is present (emoji is separate in ADF)
    const adfString = JSON.stringify(adf);
    expect(adfString).toContain("Implementation Completed by @devintern/code");
    expect(adfString).toContain("🤖");
  });

  test("createClarityAssessmentADF should include marker", () => {
    const assessment = {
      clarityScore: 8,
      isImplementable: true,
      summary: "Task is clear and implementable",
      issues: [],
      recommendations: [],
    };

    const adf = JiraFormatter.createClarityAssessmentADF(assessment);

    // Should have header with robot emoji
    expect(adf[0].type).toBe("heading");
    expect(adf[0].content[0].type).toBe("emoji");
    expect(adf[0].content[1].text).toContain("Automated Task Feasibility Assessment");

    // Verify marker text is present (emoji is separate in ADF)
    const adfString = JSON.stringify(adf);
    expect(adfString).toContain("Automated Task Feasibility Assessment");
    expect(adfString).toContain("🤖");
  });

  test("createIncompleteImplementationCommentADF should include marker", () => {
    const output = "Could not complete the task";
    const taskSummary = "Add login functionality";

    const adf = JiraFormatter.createIncompleteImplementationCommentADF(output, taskSummary);

    // Should have header with warning emoji
    expect(adf[0].type).toBe("heading");
    expect(adf[0].content[0].type).toBe("emoji");
    expect(adf[0].content[1].text).toContain("Implementation Incomplete");

    // Verify marker text is present (emoji is separate in ADF)
    const adfString = JSON.stringify(adf);
    expect(adfString).toContain("Implementation Incomplete");
    expect(adfString).toContain("⚠️");
  });

  test("all @devintern/code comments should have unique identifiable markers", () => {
    const implementationADF = JiraFormatter.createImplementationCommentADF("test");
    const assessmentADF = JiraFormatter.createClarityAssessmentADF({
      clarityScore: 5,
      isImplementable: true,
      summary: "test",
      issues: [],
      recommendations: [],
    });
    const incompleteADF = JiraFormatter.createIncompleteImplementationCommentADF("test");

    // Each should have its unique header text for identification
    expect(implementationADF[0].content[1].text).toBe(
      " Implementation Completed by @devintern/code",
    );
    expect(assessmentADF[0].content[1].text).toBe(" Automated Task Feasibility Assessment");
    expect(incompleteADF[0].content[1].text).toBe(" Implementation Incomplete");

    // These text markers (without emoji) should be sufficient for filtering in getComments
    const implementationStr = JSON.stringify(implementationADF);
    const assessmentStr = JSON.stringify(assessmentADF);
    const incompleteStr = JSON.stringify(incompleteADF);

    expect(implementationStr).toContain("Implementation Completed by @devintern/code");
    expect(assessmentStr).toContain("Automated Task Feasibility Assessment");
    expect(incompleteStr).toContain("Implementation Incomplete");

    // And they should all have their respective emojis
    expect(implementationStr).toContain("🤖");
    expect(assessmentStr).toContain("🤖");
    expect(incompleteStr).toContain("⚠️");
  });
});
