/**
 * Generic Jira issue parsing utilities: linked resources, related work, ADF conversion.
 */

import { extractTextFromADF as sharedExtractTextFromADF } from "@devintern/text-formatter";
import type {
  AtlassianDocument,
  JiraFormattedIssueDetails,
  JiraIssue,
  JiraIssueComment,
  JiraLinkedResource,
  JiraRelatedWorkItem,
} from "./types.ts";

export function extractLinkedResources(issue: JiraIssue): JiraLinkedResource[] {
  const linkedResources: JiraLinkedResource[] = [];

  try {
    const fields = issue.fields || {};

    Object.keys(fields).forEach((fieldKey) => {
      try {
        const fieldValue = fields[fieldKey];
        const fieldName = issue.names?.[fieldKey] || fieldKey;

        if (fieldValue && typeof fieldValue === "string") {
          const urlRegex = /(https?:\/\/[^\s]+)/g;
          const urls = fieldValue.match(urlRegex);
          if (urls) {
            urls.forEach((url) => {
              linkedResources.push({
                type: "custom_field_link",
                field: fieldName,
                url: url,
                description: categorizeLink(url),
              });
            });
          }
        } else if (fieldValue && typeof fieldValue === "object" && "content" in fieldValue) {
          const documentContent = (fieldValue as AtlassianDocument).content;
          if (documentContent && Array.isArray(documentContent)) {
            try {
              const content = JSON.stringify(documentContent);
              const urlRegex = /(https?:\/\/[^\s"]+)/g;
              const urls = content.match(urlRegex);
              if (urls) {
                urls.forEach((url) => {
                  linkedResources.push({
                    type: "rich_text_link",
                    field: fieldName,
                    url: url,
                    description: categorizeLink(url),
                  });
                });
              }
            } catch (jsonError) {
              console.warn(
                `Failed to process rich text content for field ${fieldName}: ${jsonError}`,
              );
            }
          }
        }
      } catch (fieldError) {
        console.warn(`Failed to process field ${fieldKey}: ${fieldError}`);
      }
    });

    if (fields.issuelinks) {
      fields.issuelinks.forEach((link) => {
        try {
          if (link.outwardIssue) {
            linkedResources.push({
              type: "issue_link",
              linkType: link.type.outward,
              issueKey: link.outwardIssue.key,
              summary: link.outwardIssue.fields.summary,
              description: `${link.type.outward} issue`,
            });
          }
          if (link.inwardIssue) {
            linkedResources.push({
              type: "issue_link",
              linkType: link.type.inward,
              issueKey: link.inwardIssue.key,
              summary: link.inwardIssue.fields.summary,
              description: `${link.type.inward} issue`,
            });
          }
        } catch (linkError) {
          console.warn(`Failed to process issue link: ${linkError}`);
        }
      });
    }

    if (
      fields.description &&
      typeof fields.description === "object" &&
      "content" in fields.description
    ) {
      try {
        const documentContent = (fields.description as AtlassianDocument).content;
        if (documentContent && Array.isArray(documentContent)) {
          const content = JSON.stringify(documentContent);
          const urlRegex = /(https?:\/\/[^\s"]+)/g;
          const urls = content.match(urlRegex);
          if (urls) {
            urls.forEach((url) => {
              linkedResources.push({
                type: "description_link",
                url: url,
                description: categorizeLink(url),
              });
            });
          }
        }
      } catch (descError) {
        console.warn(`Failed to process description links: ${descError}`);
      }
    }
  } catch (error) {
    console.warn(`Failed to extract linked resources: ${error}`);
  }

  return deduplicateLinkedResources(linkedResources);
}

function deduplicateLinkedResources(resources: JiraLinkedResource[]): JiraLinkedResource[] {
  const seen = new Map<string, JiraLinkedResource>();

  const typePriority: Record<string, number> = {
    issue_link: 4,
    custom_field_link: 3,
    rich_text_link: 2,
    description_link: 1,
  };

  resources.forEach((resource) => {
    let key: string;
    if (resource.url) {
      key = resource.url;
    } else if (resource.issueKey) {
      key = `issue:${resource.issueKey}`;
    } else {
      key = `${resource.type}:${resource.description}`;
    }

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, resource);
    } else {
      const existingPriority = typePriority[existing.type] || 0;
      const currentPriority = typePriority[resource.type] || 0;

      if (currentPriority > existingPriority) {
        seen.set(key, resource);
      } else if (currentPriority === existingPriority) {
        if (resource.field && !existing.field) {
          seen.set(key, resource);
        }
      }
    }
  });

  const deduplicated = Array.from(seen.values());

  if (resources.length !== deduplicated.length) {
    console.log(`🔗 Deduplicated linked resources: ${resources.length} → ${deduplicated.length}`);
  }

  return deduplicated;
}

function categorizeLink(url: string): string {
  if (url.includes("github.com")) return "GitHub Repository/Issue";
  if (url.includes("confluence")) return "Confluence Documentation";
  if (url.includes("figma.com")) return "Figma Design";
  if (url.includes("docs.google.com")) return "Google Document";
  if (url.includes("drive.google.com")) return "Google Drive File";
  if (url.includes("notion.so")) return "Notion Page";
  if (url.includes("miro.com")) return "Miro Board";
  return "External Link";
}

export async function getRelatedWorkItems(
  issue: JiraIssue,
  getIssueFunction: (key: string) => Promise<JiraIssue>,
): Promise<JiraRelatedWorkItem[]> {
  const relatedIssues: JiraRelatedWorkItem[] = [];
  const fields = issue.fields || {};

  try {
    if (fields.issuelinks && fields.issuelinks.length > 0) {
      console.log(`🔗 Found ${fields.issuelinks.length} linked issues, fetching details...`);

      for (const link of fields.issuelinks) {
        try {
          if (link.outwardIssue) {
            const detailedIssue = await getIssueFunction(link.outwardIssue.key);
            relatedIssues.push(formatRelatedIssue(detailedIssue, link.type.outward, "outward"));
          }

          if (link.inwardIssue) {
            const detailedIssue = await getIssueFunction(link.inwardIssue.key);
            relatedIssues.push(formatRelatedIssue(detailedIssue, link.type.inward, "inward"));
          }
        } catch (linkError) {
          console.warn(`Failed to fetch linked issue details: ${linkError}`);
        }
      }
    }

    if (fields.subtasks && Array.isArray(fields.subtasks) && fields.subtasks.length > 0) {
      console.log(`📋 Found ${fields.subtasks.length} subtasks, fetching details...`);

      for (const subtask of fields.subtasks as Array<{ key: string }>) {
        try {
          const detailedSubtask = await getIssueFunction(subtask.key);
          relatedIssues.push(formatRelatedIssue(detailedSubtask, "Subtask", "subtask"));
        } catch (subtaskError) {
          console.warn(`Failed to fetch subtask details: ${subtaskError}`);
        }
      }
    }

    if (fields.parent && typeof fields.parent === "object" && "key" in fields.parent) {
      console.log(`📋 Found parent task, fetching details...`);

      try {
        const detailedParent = await getIssueFunction((fields.parent as { key: string }).key);
        relatedIssues.push(formatRelatedIssue(detailedParent, "Parent Task", "parent"));
      } catch (parentError) {
        console.warn(`Failed to fetch parent task details: ${parentError}`);
      }
    }

    if (fields.epic && typeof fields.epic === "object" && "key" in fields.epic) {
      console.log(`🎯 Found epic, fetching details...`);

      try {
        const detailedEpic = await getIssueFunction((fields.epic as { key: string }).key);
        relatedIssues.push(formatRelatedIssue(detailedEpic, "Epic", "parent"));
      } catch (epicError) {
        console.warn(`Failed to fetch epic details: ${epicError}`);
      }
    }

    const epicLinkField = fields.customfield_10014 || fields["Epic Link"];
    if (epicLinkField && typeof epicLinkField === "string") {
      console.log(`🎯 Found epic link in custom field, fetching details...`);

      try {
        const detailedEpic = await getIssueFunction(epicLinkField);
        relatedIssues.push(formatRelatedIssue(detailedEpic, "Epic", "parent"));
      } catch (epicError) {
        console.warn(`Failed to fetch epic from custom field: ${epicError}`);
      }
    }

    console.log(`✅ Successfully fetched ${relatedIssues.length} related work items`);
    return relatedIssues;
  } catch (error) {
    console.warn(`Error fetching related work items: ${error}`);
    return relatedIssues;
  }
}

function formatRelatedIssue(
  issue: JiraIssue,
  linkType: string,
  direction: "inward" | "outward" | "subtask" | "parent",
): JiraRelatedWorkItem {
  const fields = issue.fields || {};

  return {
    key: issue.key || "Unknown",
    summary: fields.summary || "No summary",
    description: fields.description,
    renderedDescription: issue.renderedFields?.description,
    issueType: fields.issuetype?.name || "Unknown",
    status: fields.status?.name || "Unknown",
    priority: fields.priority?.name,
    assignee: fields.assignee?.displayName,
    reporter: fields.reporter?.displayName || "Unknown",
    created: fields.created || "",
    updated: fields.updated || "",
    labels: fields.labels || [],
    components: fields.components?.map((c) => c?.name || "Unknown") || [],
    fixVersions: fields.fixVersions?.map((v) => v?.name || "Unknown") || [],
    linkType,
    relationshipDirection: direction,
  };
}

export function formatIssueDetails(
  issue: JiraIssue,
  comments: JiraIssueComment[],
  linkedResources: JiraLinkedResource[],
  relatedIssues: JiraRelatedWorkItem[] = [],
): JiraFormattedIssueDetails {
  const fields = issue.fields || {};

  return {
    key: issue.key || "Unknown",
    summary: fields.summary || "No summary",
    description: fields.description,
    renderedDescription: issue.renderedFields?.description,
    issueType: fields.issuetype?.name || "Unknown",
    status: fields.status?.name || "Unknown",
    priority: fields.priority?.name,
    assignee: fields.assignee?.displayName,
    reporter: fields.reporter?.displayName || "Unknown",
    created: fields.created || "",
    updated: fields.updated || "",
    labels: fields.labels || [],
    components: fields.components?.map((c) => c?.name || "Unknown") || [],
    fixVersions: fields.fixVersions?.map((v) => v?.name || "Unknown") || [],
    linkedResources,
    relatedIssues,
    comments: comments.map((comment) => ({
      id: comment.id || "unknown",
      author:
        typeof comment.author === "string"
          ? comment.author
          : comment.author?.displayName || "Unknown",
      body: comment.body || "",
      renderedBody: comment.renderedBody,
      created: comment.created || "",
      updated: comment.updated || "",
    })),
    attachments:
      fields.attachment?.map((att) => ({
        filename: att?.filename || "unknown",
        size: att?.size || 0,
        mimeType: att?.mimeType || "unknown",
        created: att?.created || "",
        author: att?.author?.displayName || "Unknown",
        content: att?.content || "",
      })) || [],
  };
}

export function extractTextFromADF(doc: AtlassianDocument | string | undefined): string {
  return sharedExtractTextFromADF(doc, {
    arrayJoinWith: "",
    topLevelParagraphNewline: true,
    topLevelHeadingNewline: true,
  });
}

export function convertADFToMarkdown(doc: unknown): string {
  if (typeof doc === "string") {
    return doc;
  }

  if (!doc || typeof doc !== "object") {
    return "";
  }

  const d = doc as { content?: unknown[] };
  if (!d.content || !Array.isArray(d.content)) {
    return "";
  }

  let text = "";

  const processContent = (content: unknown[]): void => {
    content.forEach((node) => {
      if (!node || typeof node !== "object") return;
      const n = node as {
        type?: string;
        attrs?: { level?: number; language?: string; text?: string; displayName?: string };
        content?: unknown[];
      };

      switch (n.type) {
        case "paragraph":
          if (n.content) {
            text += processADFInlineContent(n.content) + "\n\n";
          }
          break;
        case "heading": {
          const level = n.attrs?.level || 1;
          const headingText = n.content ? processADFInlineContent(n.content) : "";
          text += "#".repeat(level) + " " + headingText + "\n\n";
          break;
        }
        case "bulletList":
        case "orderedList":
          if (n.content) {
            n.content.forEach((listItem, index) => {
              const bullet = n.type === "bulletList" ? "- " : `${index + 1}. `;
              const itemContent =
                listItem && typeof listItem === "object"
                  ? (listItem as { content?: unknown[] }).content
                  : undefined;
              const itemText = itemContent ? processADFInlineContent(itemContent) : "";
              text += bullet + itemText + "\n";
            });
            text += "\n";
          }
          break;
        case "codeBlock": {
          const language = n.attrs?.language || "";
          const codeText = n.content ? processADFInlineContent(n.content) : "";
          text += "```" + language + "\n" + codeText + "\n```\n\n";
          break;
        }
        case "blockquote":
          if (n.content) {
            const quoteText = processADFInlineContent(n.content);
            text += "> " + quoteText + "\n\n";
          }
          break;
        default:
          if (n.content) {
            processContent(n.content);
          }
      }
    });
  };

  processContent(d.content);
  return text.trim();
}

function processADFInlineContent(content: unknown[]): string {
  let text = "";

  content.forEach((node) => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: string;
      text?: string;
      marks?: Array<{ type?: string; attrs?: { href?: string } }>;
      attrs?: { text?: string; displayName?: string };
      content?: unknown[];
    };

    switch (n.type) {
      case "text": {
        let nodeText = n.text || "";
        if (n.marks) {
          n.marks.forEach((mark) => {
            switch (mark.type) {
              case "strong":
                nodeText = `**${nodeText}**`;
                break;
              case "em":
                nodeText = `*${nodeText}*`;
                break;
              case "code":
                nodeText = `\`${nodeText}\``;
                break;
              case "link": {
                const url = mark.attrs?.href || "";
                nodeText = `[${nodeText}](${url})`;
                break;
              }
            }
          });
        }
        text += nodeText;
        break;
      }
      case "hardBreak":
        text += "\n";
        break;
      case "mention": {
        const displayName = n.attrs?.text || n.attrs?.displayName || "Unknown User";
        text += `@${displayName}`;
        break;
      }
      default:
        if (n.content) {
          text += processADFInlineContent(n.content);
        }
    }
  });

  return text;
}
