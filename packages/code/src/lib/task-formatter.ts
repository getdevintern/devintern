import { writeFileSync } from "fs";
import TurndownService from "turndown";
import path from "path";
import { convertADFToMarkdown } from "@devintern/task-trackers";
import { FormattedTaskDetails, DetailedRelatedIssue } from "../types/task-tracker";

/** Converts tracker-native rich content (e.g. Jira ADF) to markdown for agent prompts. */
export type RichContentConverter = (content: unknown) => string;

export class TaskFormatter {
  private static turndownService = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    linkReferenceStyle: "full",
  });

  static {
    // Configure turndown to handle JIRA-specific HTML elements
    this.turndownService.addRule("jiraIssueLinks", {
      filter: function (node) {
        return node.nodeName === "SPAN" && node.classList.contains("jira-issue-macro");
      },
      replacement: function (content, node) {
        // Extract JIRA issue key and create a simple text reference
        const key = node.getAttribute("data-jira-key") || "";
        const link = node.querySelector("a.jira-issue-macro-key");
        const href = link ? link.getAttribute("href") : "";

        if (key && href) {
          return `[${key}](${href})`;
        }
        return key || content;
      },
    });

    // Handle JIRA status lozenges
    this.turndownService.addRule("jiraStatusLozenge", {
      filter: function (node) {
        return node.nodeName === "SPAN" && node.classList.contains("aui-lozenge");
      },
      replacement: function (content) {
        return `*${content}*`;
      },
    });

    // Handle <tt> tags as inline code
    this.turndownService.addRule("teletype", {
      filter: ["tt"],
      replacement: function (content) {
        return "`" + content + "`";
      },
    });

    // Clean up JIRA-specific attributes and classes
    this.turndownService.addRule("cleanJiraAttributes", {
      filter: function (node) {
        return (
          node.hasAttribute &&
          (node.hasAttribute("data-jira-key") ||
            node.classList.contains("jira-issue-macro-key") ||
            node.classList.contains("issue-link"))
        );
      },
      replacement: function (content) {
        return content;
      },
    });
  }

  /**
   * Build the main agent implementation prompt from formatted task tracker details.
   *
   * @param taskDetails - Normalized issue, comments, links, and attachments
   * @param trackerBaseUrl - Site URL for resolving relative attachment links
   * @param attachmentMap - Map of remote attachment URLs to local paths
   * @param outputPath - Path where the prompt will be saved (for relative image links)
   */
  static formatTaskForAgent(
    taskDetails: FormattedTaskDetails,
    trackerBaseUrl?: string,
    attachmentMap?: Map<string, string>,
    outputPath?: string,
    richContentConverter: RichContentConverter = convertADFToMarkdown,
  ): string {
    const {
      key,
      summary,
      renderedDescription,
      description,
      labels,
      components,
      linkedResources,
      relatedIssues,
      comments,
      attachments,
    } = taskDetails;

    let prompt = `# Task Implementation Request

## Task Overview
- **Key**: ${key}
- **Summary**: ${summary}
`;

    // Add labels and components if they exist
    if (labels.length > 0) {
      prompt += `- **Labels**: ${labels.join(", ")}\n`;
    }
    if (components.length > 0) {
      prompt += `- **Components**: ${components.join(", ")}\n`;
    }

    prompt += "\n## Task Description\n";

    // Use rendered description if available, otherwise fall back to raw description
    if (renderedDescription) {
      prompt +=
        this.convertHtmlToMarkdown(renderedDescription, trackerBaseUrl, attachmentMap, outputPath) +
        "\n\n";
    } else if (description) {
      prompt += richContentConverter(description) + "\n\n";
    }

    // Add linked resources
    if (linkedResources.length > 0) {
      prompt += "## Linked Resources\n\n";
      linkedResources.forEach((resource) => {
        switch (resource.type) {
          case "custom_field_link":
          case "description_link":
          case "rich_text_link":
            prompt += `- **${resource.description}**: ${resource.url}\n`;
            if (resource.field && resource.type === "custom_field_link") {
              prompt += `  (from field: ${resource.field})\n`;
            }
            break;
          case "issue_link":
            prompt += `- **${resource.linkType}**: ${resource.issueKey} - ${resource.summary}\n`;
            break;
        }
      });
      prompt += "\n";
    }

    // Add detailed related work items
    if (relatedIssues && relatedIssues.length > 0) {
      prompt += "## Related Work Items\n\n";
      prompt += "The following related issues provide important context for this task:\n\n";

      // Group related issues by type for better organization
      const groupedIssues = this.groupRelatedIssues(relatedIssues);

      Object.entries(groupedIssues).forEach(([groupName, issues]) => {
        if (issues.length > 0) {
          prompt += `### ${groupName}\n\n`;

          issues.forEach((issue) => {
            prompt += `#### ${issue.key}: ${issue.summary}\n`;
            prompt += `- **Type**: ${issue.issueType}\n`;
            prompt += `- **Status**: ${issue.status}\n`;
            if (issue.priority) {
              prompt += `- **Priority**: ${issue.priority}\n`;
            }
            if (issue.assignee) {
              prompt += `- **Assignee**: ${issue.assignee}\n`;
            }
            if (issue.labels.length > 0) {
              prompt += `- **Labels**: ${issue.labels.join(", ")}\n`;
            }
            if (issue.components.length > 0) {
              prompt += `- **Components**: ${issue.components.join(", ")}\n`;
            }

            // Add description if available
            if (issue.renderedDescription) {
              prompt += "\n**Description:**\n";
              prompt +=
                this.convertHtmlToMarkdown(
                  issue.renderedDescription,
                  trackerBaseUrl,
                  attachmentMap,
                  outputPath,
                ) + "\n";
            } else if (issue.description) {
              prompt += "\n**Description:**\n";
              prompt += richContentConverter(issue.description) + "\n";
            }

            prompt += "\n---\n\n";
          });
        }
      });
    }

    // Add attachments
    if (attachments.length > 0) {
      prompt += "## Attachments\n\n";
      attachments.forEach((att) => {
        let attachmentUrl: string;

        // Check if we have a local path for this attachment
        if (attachmentMap && attachmentMap.has(att.content)) {
          const localPath = attachmentMap.get(att.content)!;
          if (outputPath) {
            // Calculate relative path from output file to attachment
            const outputDir = path.dirname(outputPath);
            attachmentUrl = path.relative(outputDir, localPath);
            // Ensure forward slashes for markdown compatibility
            attachmentUrl = attachmentUrl.replace(/\\/g, "/");
          } else {
            attachmentUrl = localPath;
          }
        } else {
          // Fall back to original URL (may require authentication)
          attachmentUrl = att.content.startsWith("http")
            ? att.content
            : trackerBaseUrl
              ? `${trackerBaseUrl}${att.content}`
              : att.content;
        }

        // For images, use markdown image syntax; for others, use link syntax
        const isImage = att.mimeType.startsWith("image/");
        if (isImage && attachmentMap && attachmentMap.has(att.content)) {
          prompt += `- **${att.filename}**:\n  ![${att.filename}](${attachmentUrl})\n  (${att.mimeType}, ${this.formatFileSize(att.size)}) - uploaded by ${att.author}\n\n`;
        } else {
          prompt += `- **[${att.filename}](${attachmentUrl})** (${att.mimeType}, ${this.formatFileSize(att.size)}) - uploaded by ${att.author}\n`;
        }
      });
      prompt += "\n";
    }

    // Add comments if they exist
    if (comments.length > 0) {
      prompt += "## Comments and Discussion\n\n";
      comments.forEach((comment, index) => {
        prompt += `### Comment ${index + 1} by ${comment.author}\n`;
        prompt += `*Posted: ${new Date(comment.created).toLocaleString()}*\n\n`;

        if (comment.renderedBody) {
          prompt +=
            this.convertHtmlToMarkdown(
              comment.renderedBody,
              trackerBaseUrl,
              attachmentMap,
              outputPath,
            ) + "\n\n";
        } else if (comment.body) {
          prompt += richContentConverter(comment.body) + "\n\n";
        }

        prompt += "---\n\n";
      });
    }

    // Add implementation instructions
    prompt += `## Implementation Instructions

Please analyze the above task and implement the requested functionality. Consider:

1. **Requirements Analysis**: Break down what needs to be implemented based on the description and comments
2. **Technical Approach**: Determine the best technical approach based on the linked resources and context
3. **Dependencies**: Check if any external resources (Figma designs, documentation) provide additional context
4. **Testing**: Include appropriate tests for the implementation
5. **Documentation**: Update relevant documentation if needed

If you need clarification on any requirements or if the task description is unclear, please ask specific questions.

**Task Key for Reference**: ${key}
`;

    return prompt;
  }

  /**
   * Convert tracker-rendered HTML to markdown, rewriting attachment URLs when mapped locally.
   *
   * @param html - Rendered HTML from tracker
   * @param trackerBaseUrl - Site URL for relative links
   * @param attachmentMap - Remote URL to local path map
   * @param outputPath - Output file path for relative image links
   */
  static convertHtmlToMarkdown(
    html: string,
    trackerBaseUrl?: string,
    attachmentMap?: Map<string, string>,
    outputPath?: string,
  ): string {
    if (!html) return "";

    try {
      // Clean up the HTML and convert to markdown
      let markdown = this.turndownService.turndown(html);

      // Fix relative attachment URLs
      if (trackerBaseUrl || attachmentMap) {
        // Pattern: ![filename](relative/path) -> ![filename](full/url or local path)
        markdown = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, altText, urlPath) => {
          // Check various URL formats that might exist
          let candidateUrls = [urlPath];

          // If it's a relative path, add the full URL version
          if (!urlPath.startsWith("http") && trackerBaseUrl) {
            candidateUrls.push(`${trackerBaseUrl}${urlPath}`);
          }

          // If it's already a full URL, keep it
          if (urlPath.startsWith("http")) {
            candidateUrls.push(urlPath);
          }

          // Also try normalized versions (removing double slashes, etc.)
          candidateUrls.forEach((url) => {
            // Fix double slashes in URLs
            const normalized = url.replace(/([^:])\/\/+/g, "$1");
            if (normalized !== url) {
              candidateUrls.push(normalized);
            }
          });

          // Check if we have a local path for any of these URL variants
          if (attachmentMap) {
            for (const candidateUrl of candidateUrls) {
              if (attachmentMap.has(candidateUrl)) {
                const localPath = attachmentMap.get(candidateUrl)!;
                if (outputPath) {
                  // Calculate relative path from output file to attachment
                  const outputDir = path.dirname(outputPath);
                  const relativePath = path.relative(outputDir, localPath);
                  // Ensure forward slashes for markdown compatibility
                  return `![${altText}](${relativePath.replace(/\\/g, "/")})`;
                } else {
                  return `![${altText}](${localPath})`;
                }
              }
            }
          }

          // Return the best URL if no local path available
          const bestUrl = candidateUrls.find((url) => url.startsWith("http")) || urlPath;
          return `![${altText}](${bestUrl})`;
        });
      }

      // Post-process to clean up any remaining issues
      return markdown
        .replace(/\n{3,}/g, "\n\n") // Remove excessive newlines
        .replace(/^\s+|\s+$/g, "") // Trim whitespace
        .replace(/\\\[/g, "[") // Unescape brackets
        .replace(/\\\]/g, "]");
    } catch (error) {
      console.warn("Failed to convert HTML to markdown:", error);
      // Fallback: strip HTML tags manually
      return html
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
    }
  }

  /** Format a byte count as a human-readable size string. */
  static formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  /**
   * Format and write the agent task prompt to disk.
   *
   * @param taskDetails - Normalized task details
   * @param outputPath - Destination file path
   * @param trackerBaseUrl - Optional tracker base URL
   * @param attachmentMap - Optional attachment URL map
   * @returns The output path written
   */
  static saveFormattedTask(
    taskDetails: FormattedTaskDetails,
    outputPath: string,
    trackerBaseUrl?: string,
    attachmentMap?: Map<string, string>,
    richContentConverter: RichContentConverter = convertADFToMarkdown,
  ): string {
    const formattedContent = this.formatTaskForAgent(
      taskDetails,
      trackerBaseUrl,
      attachmentMap,
      outputPath,
      richContentConverter,
    );
    writeFileSync(outputPath, formattedContent, "utf8");
    return outputPath;
  }

  /**
   * Group related issues by relationship category for prompt sections.
   *
   * @param issues - Related work items with link metadata
   */
  private static groupRelatedIssues(issues: DetailedRelatedIssue[]): {
    [key: string]: DetailedRelatedIssue[];
  } {
    const grouped: { [key: string]: DetailedRelatedIssue[] } = {
      "Parent Tasks & Epics": [],
      Subtasks: [],
      "Blocking Issues": [],
      "Blocked Issues": [],
      "Related Issues": [],
      "Other Links": [],
    };

    issues.forEach((issue) => {
      switch (issue.relationshipDirection) {
        case "parent":
          grouped["Parent Tasks & Epics"].push(issue);
          break;
        case "subtask":
          grouped["Subtasks"].push(issue);
          break;
        default:
          // Categorize by link type
          const linkType = issue.linkType.toLowerCase();
          if (
            linkType.includes("block") &&
            (linkType.includes("is blocked") || issue.relationshipDirection === "inward")
          ) {
            grouped["Blocking Issues"].push(issue);
          } else if (linkType.includes("block")) {
            grouped["Blocked Issues"].push(issue);
          } else if (
            linkType.includes("relate") ||
            linkType.includes("duplicate") ||
            linkType.includes("clone")
          ) {
            grouped["Related Issues"].push(issue);
          } else {
            grouped["Other Links"].push(issue);
          }
          break;
      }
    });

    // Remove empty groups
    Object.keys(grouped).forEach((key) => {
      if (grouped[key].length === 0) {
        delete grouped[key];
      }
    });

    return grouped;
  }

  /**
   * Build an agent prompt asking for a JSON clarity/feasibility assessment.
   *
   * @param taskDetails - Normalized task details
   * @param trackerBaseUrl - Optional tracker base URL
   * @param attachmentMap - Optional attachment URL map
   * @param outputPath - Optional output path for relative links
   */
  static formatClarityAssessment(
    taskDetails: FormattedTaskDetails,
    trackerBaseUrl?: string,
    attachmentMap?: Map<string, string>,
    outputPath?: string,
    richContentConverter: RichContentConverter = convertADFToMarkdown,
  ): string {
    const {
      key,
      summary,
      renderedDescription,
      description,
      labels,
      components,
      linkedResources,
      relatedIssues,
      comments,
      attachments,
    } = taskDetails;

    let prompt = `# Task Clarity Assessment

## Your Role
You are a senior software engineer reviewing a task before implementation. Your job is to assess whether the task description provides sufficient clarity for implementation.

## Task to Review
- **Key**: ${key}
- **Summary**: ${summary}
`;

    // Add labels and components if they exist
    if (labels.length > 0) {
      prompt += `- **Labels**: ${labels.join(", ")}\n`;
    }
    if (components.length > 0) {
      prompt += `- **Components**: ${components.join(", ")}\n`;
    }

    prompt += "\n## Task Description\n";

    // Use rendered description if available, otherwise fall back to raw description
    if (renderedDescription) {
      prompt +=
        this.convertHtmlToMarkdown(renderedDescription, trackerBaseUrl, attachmentMap, outputPath) +
        "\n\n";
    } else if (description) {
      prompt += richContentConverter(description) + "\n\n";
    } else {
      prompt += "*No description provided*\n\n";
    }

    // Add linked resources
    if (linkedResources.length > 0) {
      prompt += "## Linked Resources\n\n";
      linkedResources.forEach((resource) => {
        switch (resource.type) {
          case "custom_field_link":
          case "description_link":
          case "rich_text_link":
            prompt += `- **${resource.description}**: ${resource.url}\n`;
            if (resource.field && resource.type === "custom_field_link") {
              prompt += `  (from field: ${resource.field})\n`;
            }
            break;
          case "issue_link":
            prompt += `- **${resource.linkType}**: ${resource.issueKey} - ${resource.summary}\n`;
            break;
        }
      });
      prompt += "\n";
    }

    // Add related work items (abbreviated for clarity check)
    if (relatedIssues && relatedIssues.length > 0) {
      prompt += "## Related Work Items\n\n";
      relatedIssues.forEach((issue) => {
        prompt += `- **${issue.linkType}**: ${issue.key} - ${issue.summary} (${issue.status})\n`;
      });
      prompt += "\n";
    }

    // Add recent comments for context
    if (comments.length > 0) {
      prompt += "## Recent Comments\n\n";
      // Show only the most recent 3 comments to avoid overwhelming the clarity check
      const recentComments = comments.slice(-3);
      recentComments.forEach((comment) => {
        prompt += `**${comment.author}**: `;
        if (comment.renderedBody) {
          prompt += this.convertHtmlToMarkdown(
            comment.renderedBody,
            trackerBaseUrl,
            attachmentMap,
            outputPath,
          );
        } else if (comment.body) {
          prompt += richContentConverter(comment.body);
        }
        prompt += "\n\n";
      });
    }

    prompt += `## Assessment Instructions

Please assess this task for basic implementation feasibility. Respond with a JSON object containing:

\`\`\`json
{
  "isImplementable": boolean,
  "clarityScore": number, // 1-10 scale (10 = perfectly clear)
  "issues": [
    {
      "category": "missing_requirements" | "unclear_scope" | "missing_context" | "ambiguous_description" | "critical_gaps",
      "description": "Specific issue description",
      "severity": "critical" | "major" | "minor"
    }
  ],
  "recommendations": [
    "Specific recommendation for improving clarity"
  ],
  "summary": "Brief summary of the assessment"
}
\`\`\`

## Evaluation Criteria (Relaxed for Real-World Development)

**Focus on CRITICAL blockers only:**

1. **Basic Requirement**: Is there a clear business need or user story?
2. **Scope Boundary**: Is it reasonably clear what should be changed/built?
3. **Context Clues**: Are there enough hints (URLs, related tasks, examples) to understand the domain?

**Assume developers will figure out:**
- Technical implementation details from existing codebase
- UI/UX patterns from existing similar features
- Specific styling and placement from context
- Database schemas and API patterns from codebase exploration

**Only flag as critical issues:**
- Completely missing business requirement
- Zero context about what needs to be done
- Contradictory or impossible requirements
- Missing essential business rules or data

## Decision Threshold (Relaxed)
- **isImplementable: true** - Basic requirement is clear, developer can start work (score ≥ 4)
- **isImplementable: false** - Fundamental requirement is unclear or missing (score < 4)

**Philosophy**: Trust that experienced developers can infer technical details from existing code. Focus only on whether there's enough business context to begin meaningful work.

**Task Key for Reference**: ${key}
`;

    return prompt;
  }

  /**
   * Write the clarity assessment prompt to a file.
   *
   * @param taskDetails - Normalized task details
   * @param outputPath - Destination file path
   * @param trackerBaseUrl - Optional tracker base URL
   * @param attachmentMap - Optional attachment URL map
   */
  static saveClarityAssessment(
    taskDetails: FormattedTaskDetails,
    outputPath: string,
    trackerBaseUrl?: string,
    attachmentMap?: Map<string, string>,
  ): string {
    const formattedContent = this.formatClarityAssessment(
      taskDetails,
      trackerBaseUrl,
      attachmentMap,
      outputPath,
    );
    writeFileSync(outputPath, formattedContent, "utf8");
    return outputPath;
  }

  /**
   * Build an agent prompt requesting Fibonacci story-point estimation JSON.
   *
   * @param taskDetails - Normalized task details
   * @param trackerBaseUrl - Optional tracker base URL
   * @param attachmentMap - Optional attachment URL map
   * @param outputPath - Optional output path for relative links
   */
  static formatEstimationPrompt(
    taskDetails: FormattedTaskDetails,
    trackerBaseUrl?: string,
    attachmentMap?: Map<string, string>,
    outputPath?: string,
    richContentConverter: RichContentConverter = convertADFToMarkdown,
  ): string {
    const {
      key,
      summary,
      renderedDescription,
      description,
      labels,
      components,
      linkedResources,
      relatedIssues,
      comments,
    } = taskDetails;

    let prompt = `# Story Points Estimation

## Your Role
You are a senior software engineer estimating the effort for a task using the Fibonacci scale for story points.

## Task to Estimate
- **Key**: ${key}
- **Summary**: ${summary}
`;

    if (labels.length > 0) {
      prompt += `- **Labels**: ${labels.join(", ")}\n`;
    }
    if (components.length > 0) {
      prompt += `- **Components**: ${components.join(", ")}\n`;
    }

    prompt += "\n## Task Description\n";

    if (renderedDescription) {
      prompt +=
        this.convertHtmlToMarkdown(renderedDescription, trackerBaseUrl, attachmentMap, outputPath) +
        "\n\n";
    } else if (description) {
      prompt += richContentConverter(description) + "\n\n";
    } else {
      prompt += "*No description provided*\n\n";
    }

    // Add linked resources
    if (linkedResources.length > 0) {
      prompt += "## Linked Resources\n\n";
      linkedResources.forEach((resource) => {
        switch (resource.type) {
          case "custom_field_link":
          case "description_link":
          case "rich_text_link":
            prompt += `- **${resource.description}**: ${resource.url}\n`;
            break;
          case "issue_link":
            prompt += `- **${resource.linkType}**: ${resource.issueKey} - ${resource.summary}\n`;
            break;
        }
      });
      prompt += "\n";
    }

    // Add related work items (abbreviated)
    if (relatedIssues && relatedIssues.length > 0) {
      prompt += "## Related Work Items\n\n";
      relatedIssues.forEach((issue) => {
        prompt += `- **${issue.linkType}**: ${issue.key} - ${issue.summary} (${issue.status})\n`;
      });
      prompt += "\n";
    }

    // Add recent comments for context
    if (comments.length > 0) {
      prompt += "## Recent Comments\n\n";
      const recentComments = comments.slice(-3);
      recentComments.forEach((comment) => {
        prompt += `**${comment.author}**: `;
        if (comment.renderedBody) {
          prompt += this.convertHtmlToMarkdown(
            comment.renderedBody,
            trackerBaseUrl,
            attachmentMap,
            outputPath,
          );
        } else if (comment.body) {
          prompt += richContentConverter(comment.body);
        }
        prompt += "\n\n";
      });
    }

    prompt += `## Estimation Instructions

Analyze this task and estimate the story points. Respond with ONLY a JSON object (no markdown code fences, no additional text):

{
  "storyPoints": <number>,
  "confidence": "<high|medium|low>",
  "implementationConfidence": <number>,
  "reasoning": "<string>",
  "risks": ["<string>", ...],
  "unclearAreas": ["<string>", ...],
  "summary": "<string>"
}

## Story Points Scale (Fibonacci)

- **1** — Trivial change, config tweak, typo fix
- **2** — Small, well-defined task, single file change
- **3** — Moderate task, a few files, clear requirements
- **5** — Significant feature, multiple files, some complexity
- **8** — Large feature, cross-cutting concerns, integration work
- **13** — Very large, multiple subsystems, high complexity
- **21** — Epic-sized, major architectural change, high uncertainty

## Implementation Confidence (0–10)

Rate how likely an AI coding agent can successfully implement this task autonomously:
- **9–10** — Trivial/mechanical change, almost certain success
- **7–8** — Clear requirements, standard patterns, high chance of success
- **5–6** — Moderate complexity, may need some human guidance
- **3–4** — Significant ambiguity, external dependencies, or domain knowledge needed
- **0–2** — Requires human judgment, creative decisions, or access to systems the AI cannot reach

Consider: clarity of requirements, availability of context in the codebase, need for external resources (designs, APIs, credentials), and whether the task involves subjective decisions.

## Guidelines

- Base your estimate on the scope described, not on unknowns
- Consider: code changes, testing, documentation, review effort
- If the description is vague, lean toward higher estimates and set confidence to "low"
- List specific risks that could increase effort
- List areas where the scope is unclear
- Keep reasoning concise (2-3 sentences)

**Task Key for Reference**: ${key}
`;

    return prompt;
  }

  /**
   * Write the estimation prompt to a file.
   *
   * @param taskDetails - Normalized task details
   * @param outputPath - Destination file path
   * @param trackerBaseUrl - Optional tracker base URL
   * @param attachmentMap - Optional attachment URL map
   */
  static saveEstimationPrompt(
    taskDetails: FormattedTaskDetails,
    outputPath: string,
    trackerBaseUrl?: string,
    attachmentMap?: Map<string, string>,
  ): string {
    const formattedContent = this.formatEstimationPrompt(
      taskDetails,
      trackerBaseUrl,
      attachmentMap,
      outputPath,
    );
    writeFileSync(outputPath, formattedContent, "utf8");
    return outputPath;
  }
}
