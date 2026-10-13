import { writeFileSync } from "fs";
import TurndownService from "turndown";
import path from "path";
import { convertADFToMarkdown } from "@devintern/task-trackers";
import { loadPrompt } from "../prompts/loader";
import type { LoadPromptOptions } from "../prompts/loader";
import { untrustedContentBlock } from "../prompts/untrusted-content";
import {
  FormattedTaskDetails,
  DetailedRelatedIssue,
  LinkedResource,
  Comment,
} from "../../types/task-tracker";

/** Converts tracker-native rich content (e.g. Jira ADF) to markdown for agent prompts. */
export type RichContentConverter = (content: unknown) => string;

/** Context for re-runs of a task whose previous attempt was incomplete. */
export interface RetryPromptContext {
  /** 1-based attempt number. */
  attempt: number;
  /** Why the previous attempt stopped (run record outcome or stage summary). */
  previousFailureSummary?: string;
  /** Comments created after this epoch-ms stamp are tagged as new guidance. */
  newSinceMs?: number;
}

/** Cap the previous-failure excerpt so it cannot crowd out the task itself. */
const MAX_FAILURE_SUMMARY_LENGTH = 2000;

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
    retryContext?: RetryPromptContext,
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

    const overviewLines = [`- **Key**: ${key}`, `- **Summary**: ${summary}`];
    if (labels.length > 0) {
      overviewLines.push(`- **Labels**: ${labels.join(", ")}`);
    }
    if (components.length > 0) {
      overviewLines.push(`- **Components**: ${components.join(", ")}`);
    }

    // Task tracker fields are external content: frame them so embedded
    // instructions are treated as data, not commands.
    let prompt = `# Task Implementation Request

## Task Overview

${untrustedContentBlock(overviewLines.join("\n"), "task overview")}
`;

    // Retry attempts get the previous failure up front so the agent does not
    // repeat the same mistake.
    if (retryContext) {
      prompt += `\n## Previous Attempt

This is attempt ${retryContext.attempt} at this task. A previous attempt was reported incomplete.
`;
      if (retryContext.previousFailureSummary) {
        prompt += `
Why the last attempt stopped:

${retryContext.previousFailureSummary.slice(0, MAX_FAILURE_SUMMARY_LENGTH)}
`;
      }
      prompt +=
        "\nRead the comments below for clarifications added since that attempt and prioritize them.\n";
    }

    prompt += "\n## Task Description\n\n";

    // Use rendered description if available, otherwise fall back to raw description
    const descriptionMarkdown = renderedDescription
      ? this.convertHtmlToMarkdown(renderedDescription, trackerBaseUrl, attachmentMap, outputPath)
      : description
        ? richContentConverter(description)
        : "";
    if (descriptionMarkdown.trim()) {
      prompt += untrustedContentBlock(descriptionMarkdown.trimEnd(), "task description") + "\n\n";
    }

    // Add linked resources
    if (linkedResources.length > 0) {
      let body = "";
      linkedResources.forEach((resource) => {
        switch (resource.type) {
          case "custom_field_link":
          case "description_link":
          case "rich_text_link":
            body += `- **${resource.description}**: ${resource.url}\n`;
            if (resource.field && resource.type === "custom_field_link") {
              body += `  (from field: ${resource.field})\n`;
            }
            break;
          case "issue_link":
            body += `- **${resource.linkType}**: ${resource.issueKey} - ${resource.summary}\n`;
            break;
        }
      });
      prompt +=
        "## Linked Resources\n\n" +
        untrustedContentBlock(body.trimEnd(), "linked resources") +
        "\n\n";
    }

    // Add detailed related work items
    if (relatedIssues && relatedIssues.length > 0) {
      let body = "The following related issues provide important context for this task:\n\n";

      // Group related issues by type for better organization
      const groupedIssues = this.groupRelatedIssues(relatedIssues);

      Object.entries(groupedIssues).forEach(([groupName, issues]) => {
        if (issues.length > 0) {
          body += `### ${groupName}\n\n`;

          issues.forEach((issue) => {
            body += `#### ${issue.key}: ${issue.summary}\n`;
            body += `- **Type**: ${issue.issueType}\n`;
            body += `- **Status**: ${issue.status}\n`;
            if (issue.priority) {
              body += `- **Priority**: ${issue.priority}\n`;
            }
            if (issue.assignee) {
              body += `- **Assignee**: ${issue.assignee}\n`;
            }
            if (issue.labels.length > 0) {
              body += `- **Labels**: ${issue.labels.join(", ")}\n`;
            }
            if (issue.components.length > 0) {
              body += `- **Components**: ${issue.components.join(", ")}\n`;
            }

            // Add description if available
            if (issue.renderedDescription) {
              body += "\n**Description:**\n";
              body +=
                this.convertHtmlToMarkdown(
                  issue.renderedDescription,
                  trackerBaseUrl,
                  attachmentMap,
                  outputPath,
                ) + "\n";
            } else if (issue.description) {
              body += "\n**Description:**\n";
              body += richContentConverter(issue.description) + "\n";
            }

            body += "\n---\n\n";
          });
        }
      });

      prompt +=
        "## Related Work Items\n\n" +
        untrustedContentBlock(body.trimEnd(), "related work items") +
        "\n\n";
    }

    // Add attachments
    if (attachments.length > 0) {
      let body = "";
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
          body += `- **${att.filename}**:\n  ![${att.filename}](${attachmentUrl})\n  (${att.mimeType}, ${this.formatFileSize(att.size)}) - uploaded by ${att.author}\n\n`;
        } else {
          body += `- **[${att.filename}](${attachmentUrl})** (${att.mimeType}, ${this.formatFileSize(att.size)}) - uploaded by ${att.author}\n`;
        }
      });
      prompt +=
        "## Attachments\n\n" + untrustedContentBlock(body.trimEnd(), "attachments") + "\n\n";
    }

    // Add comments if they exist
    if (comments.length > 0) {
      let body = "";
      if (retryContext?.newSinceMs !== undefined) {
        body +=
          "Comments marked *(new since last attempt)* were added after the previous " +
          "incomplete attempt — treat them as the latest guidance.\n\n";
      }
      comments.forEach((comment, index) => {
        const isNew =
          retryContext?.newSinceMs !== undefined &&
          Date.parse(comment.created) > retryContext.newSinceMs;
        body += `### Comment ${index + 1} by ${comment.author}${isNew ? " (new since last attempt)" : ""}\n`;
        body += `*Posted: ${new Date(comment.created).toLocaleString()}*\n\n`;

        if (comment.renderedBody) {
          body +=
            this.convertHtmlToMarkdown(
              comment.renderedBody,
              trackerBaseUrl,
              attachmentMap,
              outputPath,
            ) + "\n\n";
        } else if (comment.body) {
          body += richContentConverter(comment.body) + "\n\n";
        }

        body += "---\n\n";
      });
      prompt +=
        "## Comments and Discussion\n\n" +
        untrustedContentBlock(body.trimEnd(), "comments") +
        "\n\n";
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

  /**
   * Reduce a task's description to markdown, mirroring how the agent prompt
   * renders it: rendered HTML goes through the HTML converter, plain strings
   * (markdown-native trackers) pass through unchanged, and other rich content
   * (e.g. Jira ADF) goes through the per-tracker rich-content converter.
   *
   * @param taskDetails - Normalized task details (only descriptions are read)
   * @param richContentConverter - Converter for tracker-native rich content
   * @returns Markdown text, or `undefined` when there is no description
   */
  static buildTaskDescriptionMarkdown(
    taskDetails: Pick<FormattedTaskDetails, "renderedDescription" | "description">,
    richContentConverter: RichContentConverter = convertADFToMarkdown,
  ): string | undefined {
    if (taskDetails.renderedDescription) {
      return this.convertHtmlToMarkdown(taskDetails.renderedDescription).trim() || undefined;
    }
    const { description } = taskDetails;
    if (description === undefined || description === null) {
      return undefined;
    }
    if (typeof description === "string") {
      return description.trim() || undefined;
    }
    const markdown = richContentConverter(description).trim();
    return markdown || undefined;
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
    retryContext?: RetryPromptContext,
  ): string {
    const formattedContent = this.formatTaskForAgent(
      taskDetails,
      trackerBaseUrl,
      attachmentMap,
      outputPath,
      richContentConverter,
      retryContext,
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
   * Render the optional labels/components lines that follow the task summary.
   *
   * Returns a leading newline so the value can sit inline with the summary
   * placeholder in the prompt template without leaving a blank line when empty.
   *
   * @param labels - Task labels
   * @param components - Task components
   */
  private static renderMetadata(labels: string[], components: string[]): string {
    const lines: string[] = [];
    if (labels.length > 0) {
      lines.push(`- **Labels**: ${labels.join(", ")}`);
    }
    if (components.length > 0) {
      lines.push(`- **Components**: ${components.join(", ")}`);
    }
    return lines.length > 0 ? `\n${lines.join("\n")}` : "";
  }

  /**
   * Reduce a task description to markdown for the prompt body.
   *
   * @param renderedDescription - Tracker-rendered HTML, when available
   * @param description - Raw description (string or tracker-native rich content)
   * @param trackerBaseUrl - Site URL for resolving relative links
   * @param attachmentMap - Map of remote attachment URLs to local paths
   * @param outputPath - Output file path for relative image links
   * @param richContentConverter - Converter for tracker-native rich content
   */
  private static renderDescription(
    renderedDescription: string | undefined,
    description: unknown,
    trackerBaseUrl: string | undefined,
    attachmentMap: Map<string, string> | undefined,
    outputPath: string | undefined,
    richContentConverter: RichContentConverter,
  ): string {
    if (renderedDescription) {
      return this.convertHtmlToMarkdown(
        renderedDescription,
        trackerBaseUrl,
        attachmentMap,
        outputPath,
      );
    }
    if (description) {
      return richContentConverter(description);
    }
    return "";
  }

  /**
   * Frame rendered external content, returning an empty string when absent so
   * callers never emit an empty untrusted block.
   *
   * @param value - Rendered external content
   * @param source - Short human-readable origin for the framing markers
   */
  private static frameExternal(value: string, source: string): string {
    const trimmed = value.trim();
    return trimmed ? untrustedContentBlock(trimmed, source) : "";
  }

  /**
   * Render the "Linked Resources" prompt section.
   *
   * @param resources - Linked resources extracted from the task
   * @param includeFieldDetail - Include the custom-field origin sub-line
   */
  private static renderLinkedResources(
    resources: LinkedResource[],
    includeFieldDetail: boolean,
  ): string {
    if (resources.length === 0) return "";

    let section = "## Linked Resources\n\n";
    resources.forEach((resource) => {
      switch (resource.type) {
        case "custom_field_link":
        case "description_link":
        case "rich_text_link":
          section += `- **${resource.description}**: ${resource.url}\n`;
          if (includeFieldDetail && resource.field && resource.type === "custom_field_link") {
            section += `  (from field: ${resource.field})\n`;
          }
          break;
        case "issue_link":
          section += `- **${resource.linkType}**: ${resource.issueKey} - ${resource.summary}\n`;
          break;
      }
    });
    return section.trimEnd();
  }

  /**
   * Render the abbreviated "Related Work Items" prompt section.
   *
   * @param relatedIssues - Related issues with link metadata
   */
  private static renderRelatedIssuesSummary(
    relatedIssues: DetailedRelatedIssue[] | undefined,
  ): string {
    if (!relatedIssues || relatedIssues.length === 0) return "";

    let section = "## Related Work Items\n\n";
    relatedIssues.forEach((issue) => {
      section += `- **${issue.linkType}**: ${issue.key} - ${issue.summary} (${issue.status})\n`;
    });
    return section.trimEnd();
  }

  /**
   * Render the most recent three comments as a prompt section.
   *
   * @param comments - All task comments (newest appended last)
   * @param trackerBaseUrl - Site URL for resolving relative links
   * @param attachmentMap - Map of remote attachment URLs to local paths
   * @param outputPath - Output file path for relative image links
   * @param richContentConverter - Converter for tracker-native rich content
   */
  private static renderRecentComments(
    comments: Comment[],
    trackerBaseUrl: string | undefined,
    attachmentMap: Map<string, string> | undefined,
    outputPath: string | undefined,
    richContentConverter: RichContentConverter,
  ): string {
    if (comments.length === 0) return "";

    let section = "## Recent Comments\n\n";
    // Show only the most recent 3 comments to avoid overwhelming the analysis.
    comments.slice(-3).forEach((comment) => {
      section += `**${comment.author}**: `;
      if (comment.renderedBody) {
        section += this.convertHtmlToMarkdown(
          comment.renderedBody,
          trackerBaseUrl,
          attachmentMap,
          outputPath,
        );
      } else if (comment.body) {
        section += richContentConverter(comment.body);
      }
      section += "\n\n";
    });
    return section.trimEnd();
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
    promptOptions: LoadPromptOptions = {},
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

    const descriptionMarkdown = this.renderDescription(
      renderedDescription,
      description,
      trackerBaseUrl,
      attachmentMap,
      outputPath,
      richContentConverter,
    );

    return loadPrompt(
      "clarity",
      {
        key,
        summary,
        metadata: this.renderMetadata(labels, components),
        description: descriptionMarkdown.trim()
          ? untrustedContentBlock(descriptionMarkdown.trimEnd(), "task description")
          : "*No description provided*",
        linkedResources: this.frameExternal(
          this.renderLinkedResources(linkedResources, true),
          "linked resources",
        ),
        relatedIssues: this.frameExternal(
          this.renderRelatedIssuesSummary(relatedIssues),
          "related work items",
        ),
        comments: this.frameExternal(
          this.renderRecentComments(
            comments,
            trackerBaseUrl,
            attachmentMap,
            outputPath,
            richContentConverter,
          ),
          "comments",
        ),
      },
      promptOptions,
    );
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
    promptOptions: LoadPromptOptions = {},
  ): string {
    const formattedContent = this.formatClarityAssessment(
      taskDetails,
      trackerBaseUrl,
      attachmentMap,
      outputPath,
      undefined,
      promptOptions,
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
    promptOptions: LoadPromptOptions = {},
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

    const descriptionMarkdown = this.renderDescription(
      renderedDescription,
      description,
      trackerBaseUrl,
      attachmentMap,
      outputPath,
      richContentConverter,
    );

    return loadPrompt(
      "estimation",
      {
        key,
        summary,
        metadata: this.renderMetadata(labels, components),
        description: descriptionMarkdown.trim()
          ? untrustedContentBlock(descriptionMarkdown.trimEnd(), "task description")
          : "*No description provided*",
        linkedResources: this.frameExternal(
          this.renderLinkedResources(linkedResources, false),
          "linked resources",
        ),
        relatedIssues: this.frameExternal(
          this.renderRelatedIssuesSummary(relatedIssues),
          "related work items",
        ),
        comments: this.frameExternal(
          this.renderRecentComments(
            comments,
            trackerBaseUrl,
            attachmentMap,
            outputPath,
            richContentConverter,
          ),
          "comments",
        ),
      },
      promptOptions,
    );
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
    promptOptions: LoadPromptOptions = {},
  ): string {
    const formattedContent = this.formatEstimationPrompt(
      taskDetails,
      trackerBaseUrl,
      attachmentMap,
      outputPath,
      undefined,
      promptOptions,
    );
    writeFileSync(outputPath, formattedContent, "utf8");
    return outputPath;
  }
}
