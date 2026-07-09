/**
 * Jira REST API domain types for issue parsing and ADF handling.
 *
 * Shared by `@devintern/code` and `@devintern/pm` consumers via `@devintern/task-trackers`.
 */

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrls?: {
    "16x16": string;
    "24x24": string;
    "32x32": string;
    "48x48": string;
  };
}

export interface JiraIssueType {
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  subtask: boolean;
}

export interface JiraStatus {
  id: string;
  name: string;
  description?: string;
  statusCategory: {
    id: number;
    name: string;
    key: string;
    colorName: string;
  };
}

export interface JiraPriority {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface JiraComponent {
  id: string;
  name: string;
  description?: string;
}

export interface JiraVersion {
  id: string;
  name: string;
  description?: string;
  released: boolean;
  releaseDate?: string;
}

export interface JiraIssueAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  content: string;
  thumbnail?: string;
  created: string;
  author: JiraUser;
}

export interface JiraIssueLink {
  id: string;
  type: {
    id: string;
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: {
    id: string;
    key: string;
    fields: {
      summary: string;
      status: JiraStatus;
      priority: JiraPriority;
      issuetype: JiraIssueType;
    };
  };
  outwardIssue?: {
    id: string;
    key: string;
    fields: {
      summary: string;
      status: JiraStatus;
      priority: JiraPriority;
      issuetype: JiraIssueType;
    };
  };
}

export interface AtlassianDocumentNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AtlassianDocumentNode[];
  marks?: Array<{
    type: string;
    attrs?: Record<string, unknown>;
  }>;
  text?: string;
}

export interface AtlassianDocument {
  version: number;
  type: "doc";
  content: AtlassianDocumentNode[];
}

export interface JiraIssueComment {
  id?: string;
  body?: unknown;
  renderedBody?: string;
  author?: JiraUser | string;
  created?: string;
  updated?: string;
  visibility?: {
    type: string;
    value: string;
  };
}

export interface JiraIssueFields {
  summary: string;
  description?: AtlassianDocument | string;
  issuetype: JiraIssueType;
  status: JiraStatus;
  priority?: JiraPriority;
  assignee?: JiraUser;
  reporter: JiraUser;
  created: string;
  updated: string;
  labels: string[];
  components: JiraComponent[];
  fixVersions: JiraVersion[];
  attachment: JiraIssueAttachment[];
  issuelinks: JiraIssueLink[];
  [key: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
  names?: Record<string, string>;
  renderedFields?: {
    description?: string;
    [key: string]: unknown;
  };
  changelog?: {
    histories: Array<{
      id: string;
      author: JiraUser;
      created: string;
      items: Array<{
        field: string;
        fieldtype: string;
        from?: string;
        fromString?: string;
        to?: string;
        toString?: string;
      }>;
    }>;
  };
}

export interface JiraLinkedResource {
  type: string;
  field?: string;
  url?: string;
  description: string;
  linkType?: string;
  issueKey?: string;
  summary?: string;
}

export interface JiraRelatedWorkItem {
  key: string;
  summary: string;
  description?: unknown;
  renderedDescription?: string;
  issueType: string;
  status: string;
  priority?: string;
  assignee?: string;
  reporter: string;
  created: string;
  updated: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  linkType: string;
  relationshipDirection: string;
}

export interface JiraFormattedIssueDetails {
  key: string;
  summary: string;
  description?: unknown;
  renderedDescription?: string;
  issueType: string;
  status: string;
  priority?: string;
  assignee?: string;
  reporter: string;
  created: string;
  updated: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  linkedResources: JiraLinkedResource[];
  relatedIssues: JiraRelatedWorkItem[];
  comments: Array<{
    id: string;
    author: string;
    body: unknown;
    renderedBody?: string;
    created: string;
    updated: string;
  }>;
  attachments: Array<{
    filename: string;
    size: number;
    mimeType: string;
    created: string;
    author: string;
    content: string;
  }>;
}
