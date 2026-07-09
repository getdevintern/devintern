export type {
  AtlassianDocument,
  AtlassianDocumentNode,
  JiraComponent,
  JiraFormattedIssueDetails,
  JiraIssue,
  JiraIssueAttachment,
  JiraIssueComment,
  JiraIssueFields,
  JiraIssueLink,
  JiraLinkedResource,
  JiraPriority,
  JiraRelatedWorkItem,
  JiraStatus,
  JiraUser,
  JiraVersion,
} from "@devintern/task-trackers";

/** Detailed Jira comment shape used in code tests and adapters. */
export type { JiraIssueComment as JiraComment } from "@devintern/task-trackers";

export {
  type LinkedResource,
  type DetailedRelatedIssue,
  type FormattedTaskDetails,
} from "./task-tracker";

export interface JiraCommentsResponse {
  comments: import("@devintern/task-trackers").JiraIssueComment[];
  maxResults: number;
  total: number;
  startAt: number;
}

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}
