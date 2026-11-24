import { readFileSync } from "fs";
import { Utils } from "../../utils";
import { normalizeCodeHostUrl } from "../provider";

export interface GitLabApiOptions {
  token: string;
  /** Browser instance root, including any relative installation path. */
  instanceUrl: string;
  caFile?: string;
  proxy?: string;
}

/** Minimal GitLab REST transport that honors the code-host CA bundle and proxy. */
export class GitLabApi {
  readonly instanceUrl: string;
  private ca?: string;

  constructor(private options: GitLabApiOptions) {
    this.instanceUrl = normalizeCodeHostUrl(options.instanceUrl);
    if (options.caFile) this.ca = readFileSync(options.caFile, "utf8");
  }

  async request(
    path: string,
    init: RequestInit = {},
    retry?: { maxRetries?: number },
  ): Promise<Response> {
    const isForm = init.body instanceof FormData;
    return await Utils.fetchWithRetry(
      `${this.instanceUrl}/api/v4${path}`,
      {
        ...init,
        headers: {
          "PRIVATE-TOKEN": this.options.token,
          Accept: "application/json",
          // multipart bodies must keep their generated boundary header
          ...(isForm || init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
        ...(this.ca ? { tls: { ca: this.ca } } : {}),
        ...(this.options.proxy ? { proxy: this.options.proxy } : {}),
      } as RequestInit,
      retry,
    );
  }

  async json<T>(path: string, init: RequestInit = {}, retry?: { maxRetries?: number }) {
    const response = await this.request(path, init, retry);
    if (!response.ok)
      throw new Error(`${path.split("?")[0]} → ${await gitLabErrorMessage(response)}`);
    return (await response.json()) as T;
  }
}

/** Extract GitLab's error detail without echoing large response bodies. */
export async function gitLabErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
    error?: unknown;
  } | null;
  const detail = body?.message ?? body?.error;
  const text =
    typeof detail === "string"
      ? detail
      : detail && typeof detail === "object"
        ? JSON.stringify(detail)
        : "";
  return `${response.status}${text ? ` ${text.slice(0, 300)}` : ` ${response.statusText}`}`.trim();
}
