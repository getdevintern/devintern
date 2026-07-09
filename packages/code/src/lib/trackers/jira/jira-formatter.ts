/**
 * JIRA comment and post formatting utilities
 * Handles conversion of text content to Atlassian Document Format (ADF)
 */

import {
  markdownToADFContent,
  parseMarkdownTable as sharedParseMarkdownTable,
  parseTextWithFormatting as sharedParseTextWithFormatting,
  sanitizeJiraOutput,
} from "@devintern/text-formatter";

export class JiraFormatter {
  /**
   * Sanitize agent output for plain-text JIRA comments.
   *
   * @param output - Raw agent stdout
   * @returns Cleaned, length-limited text suitable for JIRA
   */
  static formatAgentOutputForJira(output: string): string {
    // Remove ANSI escape codes and control characters
    // Remove excessive whitespace and normalize line breaks
    // Trim and limit length (JIRA comments have practical limits)
    // If output is very short or empty, provide a generic message
    return sanitizeJiraOutput(output, {
      maxLength: 8000,
      minLength: 50,
      fallbackMessage:
        "@devintern completed the implementation successfully. Please check the committed changes for details.",
      collapseExcessNewlines: true,
    });
  }

  /**
   * Convert agent output into ADF content nodes for rich JIRA comments.
   *
   * @param output - Raw agent stdout
   * @returns Array of ADF block nodes
   */
  static formatAgentOutputToADF(output: string): any[] {
    // Clean the output first (remove ANSI codes, normalize line breaks, trim)
    const cleaned = sanitizeJiraOutput(output, {
      maxLength: 8000,
      minLength: 0,
      collapseExcessNewlines: false,
    });

    // Preserve existing fallback behavior for short output
    if (cleaned.length < 50) {
      return [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "@devintern completed the implementation successfully. Please check the committed changes for details.",
            },
          ],
        },
      ];
    }

    // Convert markdown-ish output to ADF nodes
    // - code blocks (```lang)
    // - headings (# ...)
    // - lists (-/*/+/1.)
    // - markdown tables
    const adfContent = markdownToADFContent(cleaned, {
      includeTables: true,
      paragraphJoinWith: " ",
    });

    return adfContent.length > 0
      ? adfContent
      : [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Implementation completed.",
              },
            ],
          },
        ];
  }

  /**
   * Parse inline markdown formatting into ADF text nodes.
   *
   * @param text - Plain text with optional bold/italic/code markers
   */
  static parseTextWithFormatting(text: string): any[] {
    return sharedParseTextWithFormatting(text);
  }

  /**
   * Parse markdown table lines into an ADF table node.
   *
   * @param tableLines - Lines comprising a markdown table
   * @returns ADF table node, or `null` when parsing fails
   */
  static parseMarkdownTable(tableLines: string[]): any | null {
    return sharedParseMarkdownTable(tableLines);
  }

  /**
   * Build ADF for a successful implementation comment posted to JIRA.
   *
   * @param agentOutput - Agent stdout to embed
   * @param taskSummary - Optional task summary line
   */
  static createImplementationCommentADF(agentOutput: string, taskSummary?: string): any[] {
    const content: any[] = [
      // Header with robot emoji and title
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          {
            type: "emoji",
            attrs: { shortName: ":robot:", id: "1f916", text: "🤖" },
          },
          {
            type: "text",
            text: " Implementation Completed by @devintern/code",
          },
        ],
      },
    ];

    // Add task summary if provided
    if (taskSummary) {
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Task: ",
            marks: [{ type: "strong" }],
          },
          {
            type: "text",
            text: taskSummary,
          },
        ],
      });
    }

    // Add implementation summary header
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Implementation Summary:",
          marks: [{ type: "strong" }],
        },
      ],
    });

    // Add Agent's output formatted as ADF
    const formattedOutput = JiraFormatter.formatAgentOutputToADF(agentOutput);
    content.push(...formattedOutput);

    // Add disclaimer
    content.push({
      type: "panel",
      attrs: { panelType: "info" },
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "This implementation was generated automatically using @devintern/code. Please review the changes before merging.",
              marks: [{ type: "em" }],
            },
          ],
        },
      ],
    });

    return content;
  }

  /**
   * Build ADF for a clarity/feasibility assessment comment.
   *
   * @param assessment - Parsed clarity assessment object
   */
  static createClarityAssessmentADF(assessment: any): any[] {
    const content: any[] = [
      // Header
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          {
            type: "emoji",
            attrs: { shortName: ":robot:", id: "1f916", text: "🤖" },
          },
          {
            type: "text",
            text: " Automated Task Feasibility Assessment",
          },
        ],
      },
      // Score and status
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Clarity Score: ",
            marks: [{ type: "strong" }],
          },
          {
            type: "text",
            text: `${assessment.clarityScore}/10`,
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Status: ",
            marks: [{ type: "strong" }],
          },
          ...(assessment.isImplementable
            ? [
                {
                  type: "emoji",
                  attrs: {
                    shortName: ":white_check_mark:",
                    id: "2705",
                    text: "✅",
                  },
                },
                {
                  type: "text",
                  text: " Ready for implementation",
                },
              ]
            : [
                {
                  type: "emoji",
                  attrs: { shortName: ":x:", id: "274c", text: "❌" },
                },
                {
                  type: "text",
                  text: " Needs fundamental clarification",
                },
              ]),
        ],
      },
      // Summary
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Summary: ",
            marks: [{ type: "strong" }],
          },
          {
            type: "text",
            text: assessment.summary,
          },
        ],
      },
    ];

    // Add issues if any
    if (assessment.issues && assessment.issues.length > 0) {
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Critical Issues Identified:",
            marks: [{ type: "strong" }],
          },
        ],
      });

      const bulletList: any[] = [];
      assessment.issues.forEach((issue: any) => {
        const severityEmoji =
          issue.severity === "critical" ? "🔴" : issue.severity === "major" ? "🟡" : "🔵";
        bulletList.push({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: `${severityEmoji} `,
                },
                {
                  type: "text",
                  text: issue.category,
                  marks: [{ type: "strong" }],
                },
                {
                  type: "text",
                  text: `: ${issue.description}`,
                },
              ],
            },
          ],
        });
      });

      content.push({
        type: "bulletList",
        content: bulletList,
      });
    }

    // Add recommendations if any
    if (assessment.recommendations && assessment.recommendations.length > 0) {
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Recommendations:",
            marks: [{ type: "strong" }],
          },
        ],
      });

      const orderedList: any[] = [];
      assessment.recommendations.forEach((rec: string) => {
        orderedList.push({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: rec,
                },
              ],
            },
          ],
        });
      });

      content.push({
        type: "orderedList",
        content: orderedList,
      });
    }

    // Add success message for passing assessments
    if (assessment.isImplementable && assessment.clarityScore >= 7) {
      content.push({
        type: "panel",
        attrs: { panelType: "success" },
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "🎯 Excellent! This task description provides clear requirements and context for implementation.",
                marks: [{ type: "strong" }],
              },
            ],
          },
        ],
      });
    } else if (assessment.isImplementable) {
      content.push({
        type: "panel",
        attrs: { panelType: "info" },
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "💡 This task is implementable, but could benefit from additional details for even clearer requirements.",
                marks: [{ type: "em" }],
              },
            ],
          },
        ],
      });
    }

    // Add disclaimer
    content.push({
      type: "panel",
      attrs: { panelType: "note" },
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "This assessment focuses on basic implementability. Technical details, UI/UX patterns, and implementation specifics are expected to be inferred from existing codebase.",
              marks: [{ type: "em" }],
            },
          ],
        },
      ],
    });

    return content;
  }

  /**
   * Build ADF for an incomplete implementation comment.
   *
   * @param agentOutput - Agent stdout describing the failed attempt
   * @param taskSummary - Optional task summary line
   */
  static createIncompleteImplementationCommentADF(
    agentOutput: string,
    taskSummary?: string,
  ): any[] {
    const content: any[] = [
      // Header with warning emoji and title
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          {
            type: "emoji",
            attrs: { shortName: ":warning:", id: "26a0-fe0f", text: "⚠️" },
          },
          {
            type: "text",
            text: " Implementation Incomplete",
          },
        ],
      },
    ];

    // Add task summary if provided
    if (taskSummary) {
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Task: ",
            marks: [{ type: "strong" }],
          },
          {
            type: "text",
            text: taskSummary,
          },
        ],
      });
    }

    // Add explanation
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "@devintern was unable to complete the implementation. This may indicate:",
        },
      ],
    });

    // Add possible reasons as bullet list
    content.push({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "The task requirements need more clarity or detail",
                },
              ],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Missing context or related information",
                },
              ],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "The task scope is too large and should be broken down",
                },
              ],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Technical blockers or errors during execution",
                },
              ],
            },
          ],
        },
      ],
    });

    // Add implementation attempt details header
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Implementation Attempt Details:",
          marks: [{ type: "strong" }],
        },
      ],
    });

    // Add Agent's output formatted as ADF
    const formattedOutput = JiraFormatter.formatAgentOutputToADF(agentOutput);
    content.push(...formattedOutput);

    // Add action panel
    content.push({
      type: "panel",
      attrs: { panelType: "warning" },
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Action Required: ",
              marks: [{ type: "strong" }],
            },
            {
              type: "text",
              text: "Please review the output above, update the task description with more details if needed, and retry the implementation.",
            },
          ],
        },
      ],
    });

    return content;
  }

  /**
   * Build ADF for a feasibility assessment failure comment.
   *
   * @param failureType - Whether the agent hit max turns or returned unparseable output
   */
  static createAssessmentFailureADF(failureType: "max-turns" | "parse-error"): unknown[] {
    const isMaxTurns = failureType === "max-turns";

    return [
      {
        type: "panel",
        attrs: { panelType: "warning" },
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "🤖 @devintern/code - Feasibility Assessment Failed",
                marks: [{ type: "strong" }],
              },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: isMaxTurns
                  ? "⚠️ Assessment reached maximum conversation turns before completion"
                  : "⚠️ Could not parse feasibility assessment response",
              },
            ],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "📋 ", marks: [{ type: "strong" }] },
              {
                type: "text",
                text: "What this means:",
                marks: [{ type: "strong" }],
              },
            ],
          },
          ...(isMaxTurns
            ? [
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "text",
                              text: "🧩 ",
                              marks: [{ type: "strong" }],
                            },
                            {
                              type: "text",
                              text: "Task complexity: ",
                              marks: [{ type: "strong" }],
                            },
                            {
                              type: "text",
                              text: "The task may involve multiple complex components or interdependencies that require extensive analysis",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "text",
                              text: "📝 ",
                              marks: [{ type: "strong" }],
                            },
                            {
                              type: "text",
                              text: "Insufficient details: ",
                              marks: [{ type: "strong" }],
                            },
                            {
                              type: "text",
                              text: "The task description may lack specific requirements, acceptance criteria, or technical specifications",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "text",
                              text: "🔍 ",
                              marks: [{ type: "strong" }],
                            },
                            {
                              type: "text",
                              text: "Context discovery: ",
                              marks: [{ type: "strong" }],
                            },
                            {
                              type: "text",
                              text: "Extensive codebase exploration was needed to understand existing patterns and architecture",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "🚀 ",
                      marks: [{ type: "strong" }],
                    },
                    {
                      type: "text",
                      text: "Next steps:",
                      marks: [{ type: "strong" }],
                    },
                  ],
                },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "text",
                              text: "Implementation will proceed with available information",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "text",
                              text: "Additional clarification may be requested during development",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "text",
                              text: "Consider adding more specific acceptance criteria for future similar tasks",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ]
            : [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "The AI assessment tool encountered an unexpected response format. Implementation will proceed but may require manual review of results.",
                    },
                  ],
                },
              ]),
        ],
      },
    ];
  }
}
