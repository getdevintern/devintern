/**
 * Jira Cloud REST API v3 client
 *
 * Shared by `@devintern/pm` (issue creation) and `@devintern/code` (workflow automation).
 *
 * API docs:
 * - Create issue: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post
 * - Get issue: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get
 * - Edit issue: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-put
 * - Create issue link: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/#api-rest-api-3-issuelink-post
 * - Get projects: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-search-get
 * - Get project: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-projectidorkey-get
 */

import { extractTextFromADF } from "@devintern/text-formatter";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fetchWithRetry } from "@devintern/utils";
import { sanitizeDomain } from "../config/load-tracker-config.ts";
import { textToADF } from "./jira-adf.ts";

export interface JiraStory {
  key: string;
  url: string;
  id: string;
}

export interface JiraTask {
  key: string;
  url: string;
}

export interface JiraIssueDetails {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  url: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  description?: string;
  subtask: boolean;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  content: string;
  thumbnail?: string;
  created: string;
  author: { displayName: string };
}

export interface JiraComment {
  id: string;
  body?: unknown;
  renderedBody?: string;
  author: { displayName: string; accountId?: string };
  created: string;
  updated: string;
}

export type JiraClientConfig =
  | {
      domain: string;
      email: string;
      apiToken: string;
      defaultProjectKey: string;
      verbose?: boolean;
    }
  | {
      baseUrl: string;
      email: string;
      apiToken: string;
      defaultProjectKey?: string;
      verbose?: boolean;
    };

export class JiraClient {
  private siteUrl!: string;
  private apiBaseUrl!: string;
  private domain!: string;
  private email!: string;
  private apiToken!: string;
  private defaultProjectKey?: string;
  private verbose!: boolean;
  private issueTypesCacheByProject = new Map<string, JiraIssueType[]>();
  private projectsCache: JiraProject[] | null = null;
  private storyPointsCandidates: Array<{ id: string; name: string }> | null = null;

  /**
   * Create a Jira Cloud REST API v3 client.
   *
   * Supports legacy `(baseUrl, email, apiToken)` and config-object construction.
   * Config objects accept either `domain` (PM) or `baseUrl` (code).
   * The legacy positional signature is deprecated; prefer {@link JiraClientConfig}.
   *
   * @param configOrBaseUrl - Jira site URL or structured client config
   * @param email - Atlassian account email (legacy signature only)
   * @param apiToken - API token or `email:token` combined credential (legacy signature only)
   * @throws When the API token is empty
   */
  constructor(baseUrl: string, email: string, apiToken: string);
  constructor(config: JiraClientConfig);
  constructor(configOrBaseUrl: JiraClientConfig | string, email?: string, apiToken?: string) {
    if (typeof configOrBaseUrl === "string") {
      if (!email || !apiToken) {
        throw new Error("JiraClient requires baseUrl, email, and apiToken");
      }
      this.applyConfig({ baseUrl: configOrBaseUrl, email, apiToken });
      return;
    }

    if ("domain" in configOrBaseUrl) {
      const domain = sanitizeDomain(configOrBaseUrl.domain);
      this.applyConfig({
        baseUrl: `https://${domain}`,
        email: configOrBaseUrl.email,
        apiToken: configOrBaseUrl.apiToken,
        defaultProjectKey: configOrBaseUrl.defaultProjectKey,
        verbose: configOrBaseUrl.verbose,
      });
      return;
    }

    this.applyConfig(configOrBaseUrl);
  }

  private applyConfig(config: {
    baseUrl: string;
    email: string;
    apiToken: string;
    defaultProjectKey?: string;
    verbose?: boolean;
  }): void {
    this.siteUrl = config.baseUrl.replace(/\/$/, "");
    this.domain = this.siteUrl.replace(/^https?:\/\//, "");
    this.apiBaseUrl = `${this.siteUrl}/rest/api/3`;
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.defaultProjectKey = config.defaultProjectKey;
    this.verbose = config.verbose ?? false;

    if (!this.apiToken || this.apiToken.length === 0) {
      throw new Error("API token is required");
    }
  }

  /** Site origin URL (e.g. `https://company.atlassian.net`). */
  get baseUrl(): string {
    return this.siteUrl;
  }

  /**
   * Perform an authenticated JIRA REST API request.
   *
   * @param method - HTTP method
   * @param url - API path (appended to base URL)
   * @param body - Optional JSON request body
   * @returns Parsed JSON body, or `null` for 204 responses
   * @throws When the API returns an error or JSON parsing fails
   */
  async jiraApiCall(method: string, url: string, body?: any): Promise<any> {
    const fullUrl = `${this.baseUrl}${url}`;
    const authHeader = this.getAuthHeader();
    if (this.verbose) {
      console.log(`🌐 JIRA API Call: ${method} ${fullUrl}`);
      console.log(`🔐 Auth header: Basic ${authHeader.replace("Basic ", "").substring(0, 10)}...`);
    }

    const response = await fetchWithRetry(
      fullUrl,
      {
        method: method,
        body: body ? Buffer.from(JSON.stringify(body), "utf-8") : undefined,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: authHeader,
        },
      },
      { verbose: this.verbose },
    );

    if (!response.ok) {
      const errorText = await response.text();
      if (this.verbose) {
        console.log(`❌ JIRA API Error: ${response.status} ${response.statusText}`);
        console.log(`   Error details: ${errorText}`);
      }
      throw new Error(`JIRA API Error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    if (response.status === 204) {
      if (this.verbose) {
        console.log(`📄 Received 204 No Content response for ${url}`);
      }
      return null;
    }

    try {
      const jsonResponse = await response.json();
      if (this.verbose) {
        console.log(`📄 Successfully parsed JSON response for ${url}`);
      }
      return jsonResponse;
    } catch (jsonError) {
      if (this.verbose) {
        console.error(`❌ Failed to parse JSON response for ${url}: ${jsonError}`);
      }
      throw new Error(`Failed to parse JSON response: ${jsonError}`);
    }
  }

  /**
   * Search issues with JQL using the REST v3 search endpoint.
   *
   * @param jql - JQL query string
   * @param startAt - Pagination offset
   * @param maxResults - Page size
   * @throws When the search request fails
   */
  async searchIssues(
    jql: string,
    startAt: number = 0,
    maxResults: number = 50,
  ): Promise<{ issues: any[]; total: number }> {
    // Use the new /rest/api/3/search/jql endpoint as per JIRA API migration
    const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(
      jql,
    )}&startAt=${startAt}&maxResults=${maxResults}&expand=names,schema`;

    try {
      const response = await this.jiraApiCall("GET", url);
      if (this.verbose) {
        console.log(`🔍 Found ${response.issues?.length || 0} issues (${response.total} total)`);
      }

      return {
        issues: response.issues || [],
        total: response.total || 0,
      };
    } catch (error) {
      if (this.verbose) {
        console.error("Failed to search issues:", error);
      }
      throw new Error(`Failed to search issues with JQL: ${jql}`);
    }
  }

  /**
   * Fetch a single JIRA issue with rendered fields when available.
   *
   * @param issueKey - Issue key (e.g. `PROJ-123`)
   * @throws When authentication fails or the issue cannot be loaded
   */
  async getIssue(issueKey: string): Promise<any> {
    if (this.verbose) {
      console.log(`🔍 Attempting to fetch issue: ${issueKey}`);
      console.log(`📡 JIRA Base URL: ${this.baseUrl}`);
      console.log(`👤 JIRA Email: ${this.email}`);
      console.log(
        `🔐 API Token: ${
          this.apiToken
            ? this.apiToken.substring(0, 4) + "..." + this.apiToken.slice(-4)
            : "NOT SET"
        }`,
      );
    }

    // Test authentication by making a simple request first
    if (this.verbose) {
      console.log(`🔐 Testing authentication...`);
    }
    try {
      const authTest = await this.jiraApiCall("GET", "/rest/api/3/myself");
      if (this.verbose) {
        console.log(
          `✅ Authentication successful - logged in as: ${authTest.displayName} (${authTest.emailAddress})`,
        );
      }
    } catch (authError) {
      if (this.verbose) {
        console.log(`❌ Authentication test failed: ${authError}`);
      }
      throw authError;
    }

    try {
      if (this.verbose) {
        console.log(`⏳ Making request to JIRA API...`);
      }
      // Use a simpler expand parameter to ensure we get the essential fields
      const response = await this.jiraApiCall(
        "GET",
        `/rest/api/3/issue/${issueKey}?expand=renderedFields`,
      );

      if (this.verbose) {
        console.log(`✅ Successfully fetched issue ${issueKey}`);
        console.log(`📝 Issue summary: ${response.fields?.summary || "No summary"}`);
        console.log(`🔍 Response keys: ${Object.keys(response)}`);
        console.log(`🔍 Has fields: ${!!response.fields}`);
        if (response.fields) {
          console.log(`🔍 Fields keys: ${Object.keys(response.fields)}`);
        } else {
          console.log(
            `⚠️  No fields found in response, this might indicate an API issue or permissions problem`,
          );
          console.log(`🔍 Full response structure:`, JSON.stringify(response, null, 2));
        }
      }

      // If fields is missing, try a fallback request without expand
      if (!response.fields) {
        if (this.verbose) {
          console.log(`🔄 Retrying without expand parameter...`);
        }
        const fallbackResponse = await this.jiraApiCall("GET", `/rest/api/3/issue/${issueKey}`);
        if (this.verbose) {
          console.log(`🔍 Fallback response has fields: ${!!fallbackResponse.fields}`);
        }
        if (fallbackResponse.fields) {
          // Add renderedFields manually if needed
          fallbackResponse.renderedFields = response.renderedFields || {};
          return fallbackResponse;
        }
      }

      return response;
    } catch (error) {
      if (this.verbose) {
        console.error(`❌ Error fetching issue ${issueKey}:`, error);
      }
      throw error;
    }
  }

  /**
   * Fetch issue comments.
   *
   * @param issueKey - Issue key
   * @returns Comment list (empty on failure)
   */
  async getIssueComments(issueKey: string): Promise<JiraComment[]> {
    try {
      const response = await this.jiraApiCall(
        "GET",
        `/rest/api/3/issue/${issueKey}/comment?expand=renderedBody`,
      );

      if (!response) {
        if (this.verbose) {
          console.log(`No comments found for ${issueKey} (empty response)`);
        }
        return [];
      }

      if (typeof response !== "object") {
        if (this.verbose) {
          console.warn(
            `Unexpected response type when fetching comments for ${issueKey}: ${typeof response}`,
          );
        }
        return [];
      }

      return response.comments || [];
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to fetch comments for ${issueKey}: ${error}`);
      }
      return [];
    }
  }

  /**
   * List attachment metadata for an issue.
   *
   * @param issueKey - Issue key
   * @returns Attachment objects from issue fields
   */
  async getIssueAttachments(issueKey: string): Promise<any[]> {
    try {
      const issue = await this.getIssue(issueKey);
      return issue.fields.attachment || [];
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to fetch attachments for ${issueKey}: ${error}`);
      }
      return [];
    }
  }

  /**
   * Download a JIRA attachment to a local directory.
   *
   * @param attachment - Attachment metadata from JIRA
   * @param outputDir - Directory to save the file
   * @returns Absolute path to the downloaded file
   * @throws When download or write fails
   */
  async downloadAttachment(attachment: JiraAttachment, outputDir: string): Promise<string> {
    try {
      if (this.verbose) {
        console.log(`📎 Downloading attachment: ${attachment.filename}...`);
      }

      // Create attachments directory if it doesn't exist
      mkdirSync(outputDir, { recursive: true });

      // Sanitize filename to avoid path traversal and filesystem issues
      const sanitizedFilename = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const localPath = path.join(outputDir, sanitizedFilename);

      // Download the attachment content
      const response = await fetchWithRetry(attachment.content, {
        headers: {
          Authorization: this.getAuthHeader(),
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
      }

      // Save to local file
      const buffer = await response.arrayBuffer();
      writeFileSync(localPath, Buffer.from(buffer));

      if (this.verbose) {
        console.log(`✅ Downloaded attachment to: ${localPath}`);
      }
      return localPath;
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to download attachment ${attachment.filename}: ${error}`);
      }
      throw error;
    }
  }

  /**
   * Download all attachments on an issue to local paths.
   *
   * @param issueKey - Issue key
   * @param outputDir - Target directory for downloads
   * @returns Map of JIRA content URL to local file path
   */
  async downloadIssueAttachments(
    issueKey: string,
    outputDir: string,
  ): Promise<Map<string, string>> {
    const attachmentMap = new Map<string, string>();

    try {
      const attachments = await this.getIssueAttachments(issueKey);

      if (attachments.length === 0) {
        if (this.verbose) {
          console.log(`📎 No attachments found for ${issueKey}`);
        }
        return attachmentMap;
      }

      if (this.verbose) {
        console.log(`📎 Found ${attachments.length} attachments for ${issueKey}`);
      }

      for (const attachment of attachments) {
        try {
          const localPath = await this.downloadAttachment(attachment, outputDir);
          // Map original content URL to local path
          attachmentMap.set(attachment.content, localPath);
        } catch (error) {
          if (this.verbose) {
            console.warn(`Skipping attachment ${attachment.filename}: ${error}`);
          }
        }
      }

      if (this.verbose) {
        console.log(
          `✅ Downloaded ${attachmentMap.size}/${attachments.length} attachments for ${issueKey}`,
        );
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to download attachments for ${issueKey}: ${error}`);
      }
    }

    return attachmentMap;
  }

  /**
   * Download attachments referenced by URLs embedded in HTML content.
   *
   * @param htmlContent - HTML containing `/rest/api/.../attachment/content/` links
   * @param outputDir - Directory for downloaded files
   * @param existingMap - Optional map to merge new downloads into
   */
  async downloadAttachmentsFromContent(
    htmlContent: string,
    outputDir: string,
    existingMap?: Map<string, string>,
  ): Promise<Map<string, string>> {
    const attachmentMap = existingMap || new Map<string, string>();

    // Extract JIRA attachment URLs from HTML content
    // Pattern: /rest/api/[2|3]/attachment/content/[id] or full URLs
    const attachmentUrlPattern =
      /(?:https?:\/\/[^\/\s]+)?\/rest\/api\/[23]\/attachment\/content\/(\d+)/g;
    const urls = new Set<string>();

    let match;
    while ((match = attachmentUrlPattern.exec(htmlContent)) !== null) {
      const fullUrl = match[0].startsWith("http") ? match[0] : `${this.baseUrl}${match[0]}`;
      urls.add(fullUrl);
    }

    if (urls.size === 0) {
      return attachmentMap;
    }

    if (this.verbose) {
      console.log(`📎 Found ${urls.size} attachment URLs in content`);
    }

    for (const url of urls) {
      // Skip if already downloaded
      if (attachmentMap.has(url)) {
        continue;
      }

      try {
        // Extract attachment ID and create a temporary attachment object
        const idMatch = url.match(/\/attachment\/content\/(\d+)/);
        if (!idMatch) continue;

        const attachmentId = idMatch[1];
        if (!attachmentId) continue;

        // Fetch attachment metadata first to get filename
        const metadataUrl = url.replace("/content/", "/");
        const metadataResponse = await fetchWithRetry(metadataUrl, {
          headers: { Authorization: this.getAuthHeader() },
        });

        if (!metadataResponse.ok) {
          if (this.verbose) {
            console.warn(`Failed to fetch attachment metadata for ${attachmentId}`);
          }
          continue;
        }

        const metadata = (await metadataResponse.json()) as any;

        // Create a fake attachment object for download
        const fakeAttachment = {
          id: attachmentId,
          filename: metadata.filename || `attachment-${attachmentId}`,
          content: url,
          size: metadata.size || 0,
          mimeType: metadata.mimeType || "application/octet-stream",
          created: metadata.created || new Date().toISOString(),
          author: metadata.author || { displayName: "Unknown" },
        };

        const localPath = await this.downloadAttachment(fakeAttachment, outputDir);
        attachmentMap.set(url, localPath);

        if (this.verbose) {
          console.log(`✅ Downloaded embedded attachment: ${metadata.filename}`);
        }
      } catch (error) {
        if (this.verbose) {
          console.warn(`Failed to download attachment from ${url}: ${error}`);
        }
      }
    }

    return attachmentMap;
  }

  /** Build the HTTP Basic Authorization header for JIRA API calls. */
  protected getAuthHeader(): string {
    if (this.apiToken.includes(":")) {
      return `Basic ${Buffer.from(this.apiToken).toString("base64")}`;
    } else {
      return `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`;
    }
  }

  /**
   * Post a plain-text comment to a JIRA issue.
   *
   * @param issueKey - Issue key
   * @param comment - Comment body (converted to simple ADF)
   * @throws When the API request fails
   */
  async postComment(issueKey: string, comment: string): Promise<void> {
    try {
      if (this.verbose) {
        console.log(`💬 Posting comment to issue ${issueKey}...`);
      }

      const commentBody = {
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: comment,
                },
              ],
            },
          ],
        },
      };

      await this.jiraApiCall("POST", `/rest/api/3/issue/${issueKey}/comment`, commentBody);
      if (this.verbose) {
        console.log(`✅ Successfully posted comment to ${issueKey}`);
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to post comment to ${issueKey}: ${error}`);
      }
      throw error;
    }
  }

  /**
   * Post a comment with pre-built ADF content nodes.
   *
   * @param issueKey - Issue key
   * @param content - ADF block nodes for the comment body
   * @throws When the API request fails
   */
  async postCommentADF(issueKey: string, content: unknown[]): Promise<void> {
    try {
      if (this.verbose) {
        console.log(`💬 Posting ADF comment to issue ${issueKey}...`);
      }

      await this.jiraApiCall("POST", `/rest/api/3/issue/${issueKey}/comment`, {
        body: {
          type: "doc",
          version: 1,
          content,
        },
      });

      if (this.verbose) {
        console.log(`✅ Successfully posted ADF comment to ${issueKey}`);
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to post ADF comment to ${issueKey}: ${error}`);
      }
      throw error;
    }
  }

  /**
   * Transition an issue to a named workflow status.
   *
   * @param issueKey - Issue key
   * @param statusName - Target status name (case-insensitive match)
   * @throws When the transition is unavailable or the API fails
   */
  async transitionIssue(issueKey: string, statusName: string): Promise<void> {
    try {
      if (this.verbose) {
        console.log(`🔄 Transitioning ${issueKey} to "${statusName}"...`);
      }

      // First, get available transitions for the issue
      const transitionsResponse = await this.jiraApiCall(
        "GET",
        `/rest/api/3/issue/${issueKey}/transitions`,
      );
      const transitions = transitionsResponse.transitions;

      // Find the transition that matches the desired status
      const targetTransition = transitions.find(
        (transition: any) => transition.to.name.toLowerCase() === statusName.toLowerCase(),
      );

      if (!targetTransition) {
        const availableStatuses = transitions.map((t: any) => t.to.name).join(", ");
        throw new Error(
          `Status "${statusName}" not available for ${issueKey}. Available: ${availableStatuses}`,
        );
      }

      // Perform the transition
      const transitionBody = {
        transition: {
          id: targetTransition.id,
        },
      };

      await this.jiraApiCall("POST", `/rest/api/3/issue/${issueKey}/transitions`, transitionBody);
      if (this.verbose) {
        console.log(`✅ Successfully transitioned ${issueKey} to "${statusName}"`);
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(`Failed to transition ${issueKey} to "${statusName}": ${error}`);
      }
      throw error;
    }
  }

  /**
   * Find an existing automated story-points estimation comment on an issue.
   *
   * @param issueKey - Issue key
   * @returns Comment id and created timestamp, or `null`
   */
  async findEstimationComment(
    issueKey: string,
  ): Promise<{ commentId: string; created: string } | null> {
    try {
      const response = await this.jiraApiCall(
        "GET",
        `/rest/api/3/issue/${issueKey}/comment?expand=renderedBody`,
      );

      if (!response || typeof response !== "object") {
        return null;
      }

      const allComments = response.comments || [];
      for (const comment of allComments) {
        let commentText = "";
        if (comment.renderedBody) {
          commentText = comment.renderedBody;
        } else if (typeof comment.body === "string" && comment.body.length > 0) {
          commentText = comment.body;
        } else if (comment.body && typeof comment.body === "object" && "content" in comment.body) {
          commentText = JSON.stringify(comment.body);
        }
        if (commentText.includes("Automated Story Points Estimation")) {
          return { commentId: comment.id, created: comment.created };
        }
      }
      return null;
    } catch (error) {
      if (this.verbose) {
        console.warn(`⚠️  Failed to check for estimation comment on ${issueKey}: ${error}`);
      }
      return null;
    }
  }

  /**
   * Discover candidate custom fields that may store story points.
   *
   * @returns Cached list of `{ id, name }` field descriptors
   */
  private async discoverStoryPointsCandidates(): Promise<Array<{ id: string; name: string }>> {
    if (this.storyPointsCandidates) {
      return this.storyPointsCandidates;
    }

    const fields = await this.jiraApiCall("GET", "/rest/api/3/field");
    const storyPointsNames = [
      "story point", // "Story Points", "Story Point Estimate", "Story point estimate"
      "story_point", // "story_points", "story_point_estimate"
      "estimation", // "Estimation" (JIRA Software board estimation field)
      "effort point", // "Effort Points"
      "sp (fibonacci", // "SP (Fibonacci)" — common custom naming
    ];

    const candidates = fields
      .filter((field: any) => {
        const fieldName = (field.name || "").toLowerCase();
        return storyPointsNames.some((name) => fieldName.includes(name));
      })
      .map((field: any) => ({ id: field.id, name: field.name }));

    this.storyPointsCandidates = candidates;
    return candidates;
  }

  /**
   * Resolve the editable story points field for an issue (via editmeta when possible).
   *
   * @param issueKey - Optional issue key to inspect edit screen fields
   * @returns Custom field id, or `null` when none found
   */
  async discoverStoryPointsField(issueKey?: string): Promise<string | null> {
    try {
      if (this.verbose) {
        console.log("🔍 Discovering story points field...");
      }
      const candidates = await this.discoverStoryPointsCandidates();

      if (candidates.length === 0) {
        if (this.verbose) {
          console.warn("⚠️  Could not find any story points field in JIRA");
        }
        return null;
      }

      // If we have an issue key, check editmeta to find which field is actually editable
      if (issueKey) {
        try {
          const editMeta = await this.jiraApiCall("GET", `/rest/api/3/issue/${issueKey}/editmeta`);
          const editableFieldIds = new Set(Object.keys(editMeta.fields || {}));

          for (const candidate of candidates) {
            if (editableFieldIds.has(candidate.id)) {
              if (this.verbose) {
                console.log(
                  `✅ Found editable story points field: "${candidate.name}" (${candidate.id})`,
                );
              }
              return candidate.id;
            }
          }
          if (this.verbose) {
            console.log("   No story points field on edit screen, will try all candidates");
          }
        } catch {
          // editmeta failed, fall through to returning first candidate
        }
      }

      // Fallback: return first candidate
      const firstCandidate = candidates[0];
      if (!firstCandidate) {
        return null;
      }
      if (this.verbose) {
        console.log(`✅ Found story points field: "${firstCandidate.name}" (${firstCandidate.id})`);
      }
      return firstCandidate.id;
    } catch (error) {
      if (this.verbose) {
        console.warn(`⚠️  Failed to discover story points field: ${error}`);
      }
      return null;
    }
  }

  /**
   * Set story points on an issue, trying alternate candidate fields on failure.
   *
   * @param issueKey - Issue key
   * @param fieldId - Primary custom field id
   * @param points - Story point value
   * @throws When no candidate field is editable for the issue
   */
  async updateStoryPoints(issueKey: string, fieldId: string, points: number): Promise<void> {
    if (this.verbose) {
      console.log(`📊 Setting story points for ${issueKey} to ${points} (field: ${fieldId})...`);
    }

    // Try the provided field first
    try {
      await this.jiraApiCall("PUT", `/rest/api/3/issue/${issueKey}`, {
        fields: { [fieldId]: points },
      });
      if (this.verbose) {
        console.log(`✅ Successfully set story points for ${issueKey} to ${points}`);
      }
      return;
    } catch (error) {
      const errorMsg = String(error);
      if (
        !errorMsg.includes("not on the appropriate screen") &&
        !errorMsg.includes("cannot be set")
      ) {
        throw error;
      }
      if (this.verbose) {
        console.log(`   Field ${fieldId} not editable, trying other candidates...`);
      }
    }

    // Try remaining candidate fields
    const candidates = await this.discoverStoryPointsCandidates();
    for (const candidate of candidates) {
      if (candidate.id === fieldId) continue;
      try {
        await this.jiraApiCall("PUT", `/rest/api/3/issue/${issueKey}`, {
          fields: { [candidate.id]: points },
        });
        if (this.verbose) {
          console.log(
            `✅ Successfully set story points for ${issueKey} to ${points} (field: "${candidate.name}" / ${candidate.id})`,
          );
        }
        return;
      } catch {
        // try next candidate
      }
    }

    throw new Error(
      `Could not set story points for ${issueKey} — none of the story points fields are editable for this issue type`,
    );
  }

  /** Build ADF block nodes for a story-points estimation comment body. */
  private buildEstimationCommentADF(result: {
    storyPoints: number;
    confidence: "high" | "medium" | "low";
    implementationConfidence?: number;
    reasoning: string;
    risks: string[];
    unclearAreas: string[];
    summary: string;
  }): any[] {
    const confidenceEmoji =
      result.confidence === "high" ? "🟢" : result.confidence === "medium" ? "🟡" : "🔴";

    const content: any[] = [
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          {
            type: "text",
            text: "🤖 Automated Story Points Estimation",
            marks: [{ type: "strong" }],
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Story Points: ",
            marks: [{ type: "strong" }],
          },
          { type: "text", text: `${result.storyPoints}` },
          { type: "text", text: "  |  " },
          {
            type: "text",
            text: "Confidence: ",
            marks: [{ type: "strong" }],
          },
          {
            type: "text",
            text: `${confidenceEmoji} ${result.confidence}`,
          },
        ],
      },
    ];

    if (typeof result.implementationConfidence === "number") {
      const score = result.implementationConfidence;
      const filled = "🟩".repeat(score);
      const empty = "⬜".repeat(10 - score);
      const label =
        score >= 9
          ? "Almost certain"
          : score >= 7
            ? "High chance"
            : score >= 5
              ? "May need guidance"
              : score >= 3
                ? "Significant ambiguity"
                : "Needs human judgment";
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "AI Implementation Confidence: ",
            marks: [{ type: "strong" }],
          },
          {
            type: "text",
            text: `${filled}${empty} ${score}/10 — ${label}`,
          },
        ],
      });
    }

    content.push(
      {
        type: "heading",
        attrs: { level: 4 },
        content: [{ type: "text", text: "Reasoning" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: result.reasoning }],
      },
    );

    if (result.risks.length > 0) {
      content.push({
        type: "heading",
        attrs: { level: 4 },
        content: [{ type: "text", text: "Risks" }],
      });
      content.push({
        type: "bulletList",
        content: result.risks.map((risk) => ({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: risk }],
            },
          ],
        })),
      });
    }

    if (result.unclearAreas.length > 0) {
      content.push({
        type: "heading",
        attrs: { level: 4 },
        content: [{ type: "text", text: "Unclear Areas" }],
      });
      content.push({
        type: "bulletList",
        content: result.unclearAreas.map((area) => ({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: area }],
            },
          ],
        })),
      });
    }

    if (result.confidence === "low") {
      content.push({
        type: "panel",
        attrs: { panelType: "warning" },
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "⚠️ Low confidence estimate — ",
                marks: [{ type: "strong" }],
              },
              {
                type: "text",
                text: "Please provide more details on the task scope and requirements for a more accurate estimate.",
              },
            ],
          },
        ],
      });
    }

    return content;
  }

  /**
   * Post a new automated story-points estimation comment.
   *
   * @param issueKey - Issue key
   * @param result - Estimation payload from the agent
   * @throws When the API request fails
   */
  async postEstimationComment(
    issueKey: string,
    result: {
      storyPoints: number;
      confidence: "high" | "medium" | "low";
      implementationConfidence?: number;
      reasoning: string;
      risks: string[];
      unclearAreas: string[];
      summary: string;
    },
  ): Promise<void> {
    try {
      if (this.verbose) {
        console.log(`💬 Posting estimation comment to ${issueKey}...`);
      }

      const commentBody = {
        body: {
          type: "doc",
          version: 1,
          content: this.buildEstimationCommentADF(result),
        },
      };

      await this.jiraApiCall("POST", `/rest/api/3/issue/${issueKey}/comment`, commentBody);
      if (this.verbose) {
        console.log(`✅ Successfully posted estimation comment to ${issueKey}`);
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(`⚠️  Failed to post estimation comment to ${issueKey}: ${error}`);
      }
      throw error;
    }
  }

  /**
   * Update an existing automated story-points estimation comment in place.
   *
   * @param issueKey - Issue key
   * @param commentId - Existing comment id
   * @param result - Updated estimation payload
   * @throws When the API request fails
   */
  async updateEstimationComment(
    issueKey: string,
    commentId: string,
    result: {
      storyPoints: number;
      confidence: "high" | "medium" | "low";
      implementationConfidence?: number;
      reasoning: string;
      risks: string[];
      unclearAreas: string[];
      summary: string;
    },
  ): Promise<void> {
    try {
      if (this.verbose) {
        console.log(`💬 Updating estimation comment ${commentId} on ${issueKey}...`);
      }

      const commentBody = {
        body: {
          type: "doc",
          version: 1,
          content: this.buildEstimationCommentADF(result),
        },
      };

      await this.jiraApiCall(
        "PUT",
        `/rest/api/3/issue/${issueKey}/comment/${commentId}`,
        commentBody,
      );
      if (this.verbose) {
        console.log(`✅ Successfully updated estimation comment on ${issueKey}`);
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(`⚠️  Failed to update estimation comment on ${issueKey}: ${error}`);
      }
      throw error;
    }
  }

  /**
   * Create a Jira issue with ADF description.
   *
   * @param summary - Issue title.
   * @param description - Plain text or markdown body (converted to ADF).
   * @param issueType - Issue type name (default `Story`).
   * @param projectKey - Optional project key override.
   * @returns Created issue key, internal ID, and browse URL.
   * @throws When the Jira API request fails or no project key is configured.
   */
  async createStory(
    summary: string,
    description: string,
    issueType: string = "Story",
    projectKey?: string,
  ): Promise<JiraStory> {
    if (!this.defaultProjectKey && !projectKey) {
      throw new Error("defaultProjectKey is required to create Jira issues");
    }

    const descriptionADF = textToADF(description);
    const issueData = {
      fields: {
        project: {
          key: projectKey || this.defaultProjectKey,
        },
        summary,
        description: descriptionADF,
        issuetype: {
          name: issueType,
        },
      },
    };

    const result = await this.jiraApiCall("POST", "/rest/api/3/issue", issueData);

    return {
      key: result.key,
      id: result.id,
      url: `${this.siteUrl}/browse/${result.key}`,
    };
  }

  /**
   * Create a Jira subtask linked to a parent issue.
   *
   * @param parentKey - Parent issue key.
   * @param summary - Subtask title.
   * @param description - Optional subtask body (converted to ADF).
   * @param projectKey - Optional project key override.
   * @returns Created subtask key and browse URL.
   * @throws When the Jira API request fails or no project key is configured.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    projectKey?: string,
  ): Promise<JiraTask> {
    if (!this.defaultProjectKey && !projectKey) {
      throw new Error("defaultProjectKey is required to create Jira subtasks");
    }

    const descriptionADF = description ? textToADF(description) : undefined;
    const issueData = {
      fields: {
        project: {
          key: projectKey || this.defaultProjectKey,
        },
        parent: {
          key: parentKey,
        },
        summary,
        description: descriptionADF,
        issuetype: {
          name: "Subtask",
        },
      },
    };

    const result = await this.jiraApiCall("POST", "/rest/api/3/issue", issueData);

    return {
      key: result.key,
      url: `${this.siteUrl}/browse/${result.key}`,
    };
  }

  /**
   * Create a directional link between two issues.
   *
   * @param inwardIssue - Inward linked issue key.
   * @param outwardIssue - Outward linked issue key.
   * @param linkType - Jira link type name (default `Relates`).
   * @throws When the Jira API request fails.
   */
  async linkIssues(
    inwardIssue: string,
    outwardIssue: string,
    linkType: string = "Relates",
  ): Promise<void> {
    await this.jiraApiCall("POST", "/rest/api/3/issueLink", {
      type: {
        name: linkType,
      },
      inwardIssue: {
        key: inwardIssue,
      },
      outwardIssue: {
        key: outwardIssue,
      },
    });
  }

  /**
   * Attach a story to an epic by setting the issue parent field.
   *
   * @param storyKey - Child issue key.
   * @param epicKey - Epic issue key.
   * @throws When the Jira API request fails.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    await this.jiraApiCall("PUT", `/rest/api/3/issue/${storyKey}`, {
      fields: {
        parent: {
          key: epicKey,
        },
      },
    });
  }

  /**
   * Fetch issue details and flatten ADF description to plain text.
   *
   * @param issueKey - Issue key or ID.
   * @returns Summary, description, type, status, and URL.
   * @throws When the Jira API request fails.
   */
  async getIssueDetails(issueKey: string): Promise<JiraIssueDetails> {
    const result = await this.jiraApiCall(
      "GET",
      `/rest/api/3/issue/${issueKey}?fields=summary,description,issuetype,status`,
    );

    const description = result.fields.description
      ? extractTextFromADF(result.fields.description, { arrayJoinWith: " " })
      : "";

    return {
      key: result.key,
      summary: result.fields.summary,
      description,
      issueType: result.fields.issuetype.name,
      status: result.fields.status.name,
      url: `${this.siteUrl}/browse/${result.key}`,
    };
  }

  /**
   * List projects visible to the authenticated user (cached after first call).
   *
   * @returns Up to 100 accessible projects.
   * @throws When the Jira API request fails.
   */
  async getProjects(): Promise<JiraProject[]> {
    if (this.projectsCache) {
      return this.projectsCache;
    }

    const result = await this.jiraApiCall("GET", "/rest/api/3/project/search?maxResults=100");
    const projects: JiraProject[] =
      result.values?.map((project: any) => ({
        id: project.id,
        key: project.key,
        name: project.name,
        projectTypeKey: project.projectTypeKey,
      })) || [];

    this.projectsCache = projects;
    return projects;
  }

  /**
   * List non-subtask issue types for a project (cached per project key).
   *
   * @param projectKey - Optional project key; defaults to configured project.
   * @returns Issue type metadata for the project.
   * @throws When the Jira API request fails or no project key is available.
   */
  async getIssueTypes(projectKey?: string): Promise<JiraIssueType[]> {
    const targetProjectKey = projectKey || this.defaultProjectKey;
    if (!targetProjectKey) {
      throw new Error("projectKey or defaultProjectKey is required to list issue types");
    }

    const cached = this.issueTypesCacheByProject.get(targetProjectKey);
    if (cached) {
      return cached;
    }

    const result = await this.jiraApiCall("GET", `/rest/api/3/project/${targetProjectKey}`);
    const issueTypes: JiraIssueType[] =
      result.issueTypes
        ?.filter((type: any) => !type.subtask)
        .map((type: any) => ({
          id: type.id,
          name: type.name,
          description: type.description,
          subtask: type.subtask,
        })) || [];

    this.issueTypesCacheByProject.set(targetProjectKey, issueTypes);
    return issueTypes;
  }
}
