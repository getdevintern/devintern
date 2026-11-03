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
  /**
   * Require an HTTP(S) remote to match the configured instance's port.
   *
   * The repo-scoped GitLab project pin opts in so a code mirror on `:9443`
   * cannot be paired with a tracker at `:8443`. General remote parsing keeps
   * matching HTTP remotes by hostname, because a split git/web-port layout
   * (`git clone` on `:8443`, web/API on the default port) is still the same
   * instance and must not turn into an unknown repository.
   */
  requireHttpPort?: boolean;
}

interface RemoteParts {
  hostname: string;
  /**
   * `hostname[:port]` when the remote is an HTTP(S) URL, whose port identifies
   * the web endpoint. Null for SSH/SCP remotes, whose port (if any) is the SSH
   * transport and says nothing about the tracker's HTTP instance.
   */
  httpHost: string | null;
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
      const http = url.protocol === "http:" || url.protocol === "https:";
      return {
        hostname: url.hostname.toLowerCase(),
        httpHost: http ? url.host.toLowerCase() : null,
        path: decodeURIComponent(url.pathname).replace(/^\/+/, ""),
      };
    } catch {
      return null;
    }
  }

  // SCP-style SSH URL: git@example.com:group/project.git
  const scp = trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  if (!scp?.[1] || !scp[2]) return null;
  return { hostname: scp[1].toLowerCase(), httpHost: null, path: scp[2].replace(/^\/+/, "") };
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
  /** `hostname[:port]` — the HTTP endpoint identity of the tracker instance. */
  host: string;
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
      host: parsed.host.toLowerCase(),
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
 * Compare an HTTP(S) endpoint identity (`hostname[:port]`) with the configured
 * instance.
 *
 * With `requireHttpPort` the ports must agree; without it only the hostname is
 * compared, which keeps split git/web-port clone layouts on the same instance.
 */
function httpHostMatchesInstance(
  hostname: string,
  httpHost: string,
  configured: { hostname: string; host: string },
  requireHttpPort: boolean,
): boolean {
  return requireHttpPort ? httpHost === configured.host : hostname === configured.hostname;
}

/**
 * Whether the remote names the configured instance's web endpoint.
 *
 * SSH/SCP remotes only name the code host, so they are compared by hostname;
 * their transport port says nothing about the tracker's HTTP endpoint.
 */
function remoteMatchesInstance(
  remote: RemoteParts,
  configured: { hostname: string; host: string },
  requireHttpPort: boolean,
): boolean {
  return remote.httpHost === null
    ? remote.hostname === configured.hostname
    : httpHostMatchesInstance(remote.hostname, remote.httpHost, configured, requireHttpPort);
}

/** Whether the remote is gitlab.com, honoring the optional port requirement. */
function remoteIsGitLabCom(remote: RemoteParts, requireHttpPort: boolean): boolean {
  return requireHttpPort && remote.httpHost !== null
    ? remote.httpHost === "gitlab.com"
    : remote.hostname === "gitlab.com";
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
  const requireHttpPort = options.requireHttpPort === true;
  const isGitLabCom = remoteIsGitLabCom(remote, requireHttpPort);
  const matchesConfigured =
    configured &&
    (remoteMatchesInstance(remote, configured, requireHttpPort) ||
      configured.aliases.has(remote.hostname));
  if (!isGitLabCom && !matchesConfigured) return null;

  let path = remote.path;
  if (
    configured &&
    (remoteMatchesInstance(remote, configured, requireHttpPort) ||
      (!isGitLabCom && configured.aliases.has(remote.hostname))) &&
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
  const httpHost = url.host.toLowerCase();
  const isGitLabCom = httpHost === "gitlab.com";
  if (
    !isGitLabCom &&
    !(configured && httpHostMatchesInstance(hostname, httpHost, configured, true))
  ) {
    return null;
  }

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
