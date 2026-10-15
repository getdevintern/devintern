function repositoryPath(value: string | undefined, variable: string, nested: boolean): string {
  const path = value?.trim() ?? "";
  const parts = path.split("/");
  if (
    parts.length < 2 ||
    (!nested && parts.length !== 2) ||
    parts.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")
  ) {
    throw new Error(`Set ${variable} to a dedicated fixture repository path, not a URL`);
  }
  return path;
}

function requiredToken(value: string | undefined, variable: string): string {
  if (!value?.trim()) throw new Error(`Set ${variable} for the hosted E2E suite`);
  return value.trim();
}

export function resolveBitbucketConfig(env: Record<string, string | undefined> = process.env) {
  return {
    repository: repositoryPath(env.E2E_BITBUCKET_REPOSITORY, "E2E_BITBUCKET_REPOSITORY", false),
    token: requiredToken(env.E2E_BITBUCKET_TOKEN, "E2E_BITBUCKET_TOKEN"),
  };
}

export function resolveGitLabComConfig(env: Record<string, string | undefined> = process.env) {
  return {
    projectPath: repositoryPath(env.E2E_GITLAB_COM_PROJECT, "E2E_GITLAB_COM_PROJECT", true),
    token: requiredToken(env.E2E_GITLAB_COM_TOKEN, "E2E_GITLAB_COM_TOKEN"),
  };
}
