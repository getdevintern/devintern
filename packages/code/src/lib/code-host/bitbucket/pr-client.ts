import { Utils } from "../../utils";
import { PRClient } from "../base-client";
import type { PRInfo, PRResult } from "../shared";

export class BitbucketPRClient extends PRClient {
  private workspace: string;

  /**
   * @param token - Bitbucket app password or access token
   * @param workspace - Bitbucket workspace slug
   * @param baseUrl - Bitbucket API base URL
   */
  constructor(token: string, workspace: string, baseUrl = "https://api.bitbucket.org/2.0") {
    super(token, baseUrl);
    this.workspace = workspace;
  }

  /** @inheritdoc PRClient.createPullRequest */
  async createPullRequest(prInfo: PRInfo): Promise<PRResult> {
    try {
      const url = `${this.baseUrl}/repositories/${this.workspace}/${prInfo.repository}/pullrequests`;

      const response = await Utils.fetchWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: prInfo.title,
          description: prInfo.body,
          source: {
            branch: {
              name: prInfo.sourceBranch,
            },
          },
          destination: {
            branch: {
              name: prInfo.targetBranch,
            },
          },
          close_source_branch: false,
        }),
      });

      if (!response.ok) {
        const errorData = (await response
          .json()
          .catch(() => ({ error: { message: "Unknown error" } }))) as any;
        return {
          success: false,
          message: `Bitbucket PR creation failed: ${
            errorData.error?.message || response.statusText
          }`,
        };
      }

      const data = (await response.json()) as any;
      return {
        success: true,
        url: data.links.html.href,
        message: `Pull request created successfully: ${data.links.html.href}`,
        ...(data.id
          ? {
              changeRequest: {
                provider: "bitbucket" as const,
                instanceUrl: "https://bitbucket.org",
                projectPath: `${this.workspace}/${prInfo.repository}`,
                number: data.id as number,
                webUrl: data.links.html.href as string,
              },
            }
          : {}),
      };
    } catch (error) {
      return {
        success: false,
        message: `Bitbucket PR creation failed: ${(error as Error).message}`,
      };
    }
  }
}
