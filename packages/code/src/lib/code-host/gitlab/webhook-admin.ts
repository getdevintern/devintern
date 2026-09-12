/** Local-only GitLab project-hook administration for hosted relay delivery. */

import { readFileSync } from "fs";

import { normalizeCodeHostUrl } from "../index";
import { Utils } from "../../utils";

const MAINTAINER_ACCESS_LEVEL = 40;
const MANAGED_HOOK_NAME = "DevIntern Relay";

export interface GitLabWebhookProject {
  id: number;
  path: string;
  accessLevel: number;
}

export interface GitLabProjectHook {
  id: number;
  url: string;
  name?: string;
}

export interface GitLabWebhookAdminOptions {
  caFile?: string;
  proxy?: string;
  fetch?: typeof fetch;
}

export interface GitLabRelayHookConfig {
  ingestUrl: string;
  legacySecret: string;
  signingToken?: string;
}

interface GitLabProjectResponse {
  id: number;
  path_with_namespace: string;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}

/** REST v4 client whose API token and TLS material never leave the local worker. */
export class GitLabWebhookAdminClient {
  readonly instanceUrl: string;
  private apiUrl: string;
  private token: string;
  private ca?: string;
  private proxy?: string;
  private fetchImpl: typeof fetch;

  constructor(token: string, instanceUrl: string, options: GitLabWebhookAdminOptions = {}) {
    this.instanceUrl = normalizeCodeHostUrl(instanceUrl);
    this.apiUrl = `${this.instanceUrl}/api/v4`;
    this.token = token;
    this.proxy = options.proxy;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (options.caFile) this.ca = readFileSync(options.caFile, "utf8");
  }

  /** Resolve immutable identity and enforce GitLab's project-hook permission boundary. */
  async resolveMaintainedProject(projectPath: string): Promise<GitLabWebhookProject> {
    const project = await this.requestJson<GitLabProjectResponse>(
      `/projects/${encodeURIComponent(projectPath)}`,
    );
    const accessLevel = Math.max(
      project.permissions?.project_access?.access_level ?? 0,
      project.permissions?.group_access?.access_level ?? 0,
    );
    if (accessLevel < MAINTAINER_ACCESS_LEVEL) {
      throw new Error(
        `GitLab project hooks require Maintainer or Owner access for ${project.path_with_namespace}. ` +
          "Set GITLAB_WEBHOOK_ADMIN_TOKEN to a token with that access; polling remains enabled.",
      );
    }
    return { id: project.id, path: project.path_with_namespace, accessLevel };
  }

  async listHooks(projectId: number): Promise<GitLabProjectHook[]> {
    return this.requestJson<GitLabProjectHook[]>(`/projects/${projectId}/hooks`);
  }

  async getHook(projectId: number, hookId: number): Promise<GitLabProjectHook | null> {
    const response = await this.request(`/projects/${projectId}/hooks/${hookId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await this.errorMessage(response));
    return (await response.json()) as GitLabProjectHook;
  }

  /** Update only a locally remembered DevIntern hook; otherwise create a fresh hook. */
  async upsertRelayHook(
    projectId: number,
    config: GitLabRelayHookConfig,
    existingHookId?: number,
  ): Promise<{ hook: GitLabProjectHook; standardSigning: boolean }> {
    const standardSigning = await this.supportsStandardSigning();
    const existing = existingHookId ? await this.getHook(projectId, existingHookId) : null;
    const updateExisting = existing && this.isManagedHook(existing, config.ingestUrl);
    const path = updateExisting
      ? `/projects/${projectId}/hooks/${existing.id}`
      : `/projects/${projectId}/hooks`;
    const method = updateExisting ? "PUT" : "POST";
    const body = this.hookBody(config, standardSigning);
    let response = await this.request(path, { method, body: JSON.stringify(body) });
    let usedStandardSigning = standardSigning;
    if (!response.ok && standardSigning && [400, 422].includes(response.status)) {
      response = await this.request(path, {
        method,
        body: JSON.stringify(this.hookBody(config, false)),
      });
      usedStandardSigning = false;
    }
    if (!response.ok)
      throw new Error(`GitLab hook setup failed: ${await this.errorMessage(response)}`);
    return {
      hook: (await response.json()) as GitLabProjectHook,
      standardSigning: usedStandardSigning,
    };
  }

  async testHook(projectId: number, hookId: number): Promise<void> {
    const response = await this.request(`/projects/${projectId}/hooks/${hookId}/test/note_events`, {
      method: "POST",
    });
    if (!response.ok)
      throw new Error(`GitLab hook test failed: ${await this.errorMessage(response)}`);
  }

  async deleteHook(projectId: number, hookId: number): Promise<boolean> {
    const response = await this.request(`/projects/${projectId}/hooks/${hookId}`, {
      method: "DELETE",
    });
    if (response.status === 404) return false;
    if (!response.ok)
      throw new Error(`GitLab hook removal failed: ${await this.errorMessage(response)}`);
    return true;
  }

  private async supportsStandardSigning(): Promise<boolean> {
    if (this.instanceUrl === "https://gitlab.com") return true;
    try {
      const version = await this.requestJson<{ version?: string }>("/version");
      const major = Number.parseInt(version.version?.split(".")[0] ?? "", 10);
      return Number.isInteger(major) && major >= 19;
    } catch {
      return false;
    }
  }

  private hookBody(
    config: GitLabRelayHookConfig,
    standardSigning: boolean,
  ): Record<string, unknown> {
    return {
      name: MANAGED_HOOK_NAME,
      description: "Reference-only events for the DevIntern hosted relay",
      url: config.ingestUrl,
      token: config.legacySecret,
      ...(standardSigning && config.signingToken ? { signing_token: config.signingToken } : {}),
      note_events: true,
      merge_requests_events: true,
      pipeline_events: true,
      job_events: true,
      enable_ssl_verification: true,
    };
  }

  private isManagedHook(hook: GitLabProjectHook, replacementUrl: string): boolean {
    if (hook.name === MANAGED_HOOK_NAME) return true;
    try {
      const previous = new URL(hook.url);
      const replacement = new URL(replacementUrl);
      return (
        previous.origin === replacement.origin &&
        /^\/ingest\/gitlab\/[a-f0-9]{64}$/.test(previous.pathname)
      );
    } catch {
      return false;
    }
  }

  private async requestJson<T>(path: string): Promise<T> {
    const response = await this.request(path);
    if (!response.ok) throw new Error(await this.errorMessage(response));
    return (await response.json()) as T;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const requestInit = {
      ...init,
      headers: {
        "PRIVATE-TOKEN": this.token,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
      ...(this.ca ? { tls: { ca: this.ca } } : {}),
      ...(this.proxy ? { proxy: this.proxy } : {}),
    } as RequestInit;
    return this.fetchImpl === globalThis.fetch
      ? Utils.fetchWithRetry(`${this.apiUrl}${path}`, requestInit)
      : this.fetchImpl(`${this.apiUrl}${path}`, requestInit);
  }

  private async errorMessage(response: Response): Promise<string> {
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
      error?: unknown;
    } | null;
    const detail = body?.message ?? body?.error;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") return JSON.stringify(detail);
    return `${response.status} ${response.statusText}`.trim();
  }
}
