/** Code-host providers understood by DevIntern. */
export type CodeHostProvider = "github" | "gitlab" | "bitbucket";

/** Provider-neutral repository identity resolved from a Git remote. */
export interface CodeHostRepository {
  provider: CodeHostProvider;
  /** Browser/API instance root, without a trailing slash. */
  instanceUrl: string;
  /** Full namespace path (`group/subgroup/project` for GitLab). */
  projectPath: string;
  /** Legacy repository value consumed by the existing PR clients. */
  repository: string;
  /** Bitbucket workspace retained for its existing client contract. */
  workspace?: string;
}

/** Durable identity for a pull or merge request. */
export interface ChangeRequestIdentity {
  provider: CodeHostProvider;
  instanceUrl: string;
  projectId?: string;
  projectPath: string;
  /** Pull-request number or GitLab project-scoped merge-request IID. */
  number: number;
  webUrl: string;
}

export interface GitRemoteParseOptions {
  /** GitLab browser instance root, including a relative installation path. */
  gitlabBaseUrl?: string;
  /** SSH hostnames that resolve to the configured GitLab instance. */
  gitlabHostAliases?: Iterable<string>;
}

interface RemoteParts {
  hostname: string;
  path: string;
}

/** Normalize a configured HTTP(S) instance URL. */
export function normalizeCodeHostUrl(value: string): string {
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Code-host URL must use http or https: ${value}`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

/** Parse a comma-separated list of SSH aliases for the default GitLab host. */
export function parseGitLabHostAliases(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((alias) => alias.trim().toLowerCase())
    .filter(Boolean);
}

function parseRemoteParts(remoteUrl: string): RemoteParts | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        hostname: url.hostname.toLowerCase(),
        path: decodeURIComponent(url.pathname).replace(/^\/+/, ""),
      };
    } catch {
      return null;
    }
  }

  // SCP-style SSH URL: git@example.com:group/project.git
  const scp = trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  if (!scp?.[1] || !scp[2]) return null;
  return { hostname: scp[1].toLowerCase(), path: scp[2].replace(/^\/+/, "") };
}

function cleanProjectPath(path: string): string | null {
  const cleaned = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function configuredGitLab(options: GitRemoteParseOptions): {
  instanceUrl: string;
  hostname: string;
  pathPrefix: string;
  aliases: Set<string>;
} | null {
  if (!options.gitlabBaseUrl) return null;
  try {
    const instanceUrl = normalizeCodeHostUrl(options.gitlabBaseUrl);
    const parsed = new URL(instanceUrl);
    return {
      instanceUrl,
      hostname: parsed.hostname.toLowerCase(),
      pathPrefix: parsed.pathname.replace(/^\/+|\/+$/g, ""),
      aliases: new Set(
        [...(options.gitlabHostAliases ?? [])].map((alias) => alias.trim().toLowerCase()),
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Parse an HTTPS, SSH URL, or SCP-style Git remote without network probing.
 */
export function parseGitRemoteUrl(
  remoteUrl: string,
  options: GitRemoteParseOptions = {},
): CodeHostRepository | null {
  const remote = parseRemoteParts(remoteUrl);
  if (!remote) return null;

  if (remote.hostname === "github.com") {
    const projectPath = cleanProjectPath(remote.path);
    if (!projectPath || projectPath.split("/").length !== 2) return null;
    return {
      provider: "github",
      instanceUrl: "https://github.com",
      projectPath,
      repository: projectPath,
    };
  }

  if (remote.hostname === "bitbucket.org") {
    const projectPath = cleanProjectPath(remote.path);
    if (!projectPath) return null;
    const [workspace, repository, ...rest] = projectPath.split("/");
    if (!workspace || !repository || rest.length > 0) return null;
    return {
      provider: "bitbucket",
      instanceUrl: "https://bitbucket.org",
      projectPath,
      repository,
      workspace,
    };
  }

  const configured = configuredGitLab(options);
  const isGitLabCom = remote.hostname === "gitlab.com";
  const matchesConfigured =
    configured &&
    (remote.hostname === configured.hostname || configured.aliases.has(remote.hostname));
  if (!isGitLabCom && !matchesConfigured) return null;

  let path = remote.path;
  if (
    configured &&
    remote.hostname === configured.hostname &&
    configured.pathPrefix &&
    (path === configured.pathPrefix || path.startsWith(`${configured.pathPrefix}/`))
  ) {
    path = path.slice(configured.pathPrefix.length).replace(/^\/+/, "");
  }
  const projectPath = cleanProjectPath(path);
  if (!projectPath) return null;

  return {
    provider: "gitlab",
    instanceUrl: isGitLabCom ? "https://gitlab.com" : configured!.instanceUrl,
    projectPath,
    repository: projectPath,
  };
}

/** Parse a provider change-request URL into its durable identity. */
export function parseChangeRequestUrl(
  value: string,
  options: Pick<GitRemoteParseOptions, "gitlabBaseUrl"> = {},
): ChangeRequestIdentity | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const hostname = url.hostname.toLowerCase();
  const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");

  if (hostname === "github.com") {
    const match = path.match(/^([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/);
    if (!match?.[1] || !match[2]) return null;
    return {
      provider: "github",
      instanceUrl: "https://github.com",
      projectPath: match[1],
      number: Number(match[2]),
      webUrl: url.toString(),
    };
  }

  if (hostname === "bitbucket.org") {
    const match = path.match(/^([^/]+\/[^/]+)\/pull-requests\/(\d+)$/);
    if (!match?.[1] || !match[2]) return null;
    return {
      provider: "bitbucket",
      instanceUrl: "https://bitbucket.org",
      projectPath: match[1],
      number: Number(match[2]),
      webUrl: url.toString(),
    };
  }

  const configured = configuredGitLab(options);
  const isGitLabCom = hostname === "gitlab.com";
  if (!isGitLabCom && hostname !== configured?.hostname) return null;

  let relativePath = path;
  if (
    !isGitLabCom &&
    configured?.pathPrefix &&
    (relativePath === configured.pathPrefix || relativePath.startsWith(`${configured.pathPrefix}/`))
  ) {
    relativePath = relativePath.slice(configured.pathPrefix.length).replace(/^\/+/, "");
  }
  const match = relativePath.match(/^(.+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/);
  if (!match?.[1] || !match[2] || !cleanProjectPath(match[1])) return null;
  return {
    provider: "gitlab",
    instanceUrl: isGitLabCom ? "https://gitlab.com" : configured!.instanceUrl,
    projectPath: match[1],
    number: Number(match[2]),
    webUrl: url.toString(),
  };
}
